import { useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import type { QAModels } from "../services/api";
import { API_KEY_STORAGE_KEY } from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useQAModels } from "../hooks/useQAModels";
import { Spinner } from "../components/Spinner";

const MODEL_STORAGE_KEY = "askdocs-model";

/**
 * Shown when the models endpoint is unavailable so the page never breaks.
 *
 * `free` must only contain models that are genuinely usable without paying,
 * matching the backend's own `tier: "free"` classification. It used to list
 * `gpt-4o-mini` here, which the backend deliberately reclassifies as paid
 * because it bills per token — so the offline fallback offered, under a "free"
 * heading, the one option that costs the operator money. `gpt-oss-120b` is the
 * free-tier Groq model and the backend's own free-first default.
 */
const DEFAULT_MODELS: QAModels = {
  free: ["openai/gpt-oss-120b", "llama-3.3-70b-versatile"],
  paid: ["gpt-4o-mini", "gpt-4o", "gpt-4", "gpt-4-turbo"],
};

interface Notice {
  type: "success" | "error";
  text: string;
}

/* 18px Feather-style glyphs for the section headers, aria-hidden because
   each icon accompanies a visible heading. */
function SectionIcon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

function UserIcon() {
  return (
    <SectionIcon>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </SectionIcon>
  );
}

function CpuIcon() {
  return (
    <SectionIcon>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3" />
    </SectionIcon>
  );
}

function KeyIcon() {
  return (
    <SectionIcon>
      <path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777Zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4" />
    </SectionIcon>
  );
}

export function SettingsPage() {
  const { user } = useAuth();
  const modelsQuery = useQAModels();
  // The models endpoint is optional — the page keeps working with defaults
  // when it is unreachable (e.g. no provider configured).
  const models: QAModels | null =
    modelsQuery.isError ? DEFAULT_MODELS : (modelsQuery.data ?? null);
  const isLoadingModels = modelsQuery.isPending && !modelsQuery.data;
  const modelsError = modelsQuery.isError
    ? (modelsQuery.error as Error).message
    : null;
  const [selectedModel, setSelectedModel] = useState<string>(
    // Last resort only: DEFAULT_MODELS.free is never empty, so a save that
    // points at a model the backend no longer offers simply falls back to the
    // first free one rather than selecting nothing.
    () =>
      localStorage.getItem(MODEL_STORAGE_KEY) ??
      DEFAULT_MODELS.free[0] ??
      "gpt-4o-mini",
  );
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);

  /* What the key field is currently saying, in words (#588).
     A boolean mirror of storage is ambiguous as soon as the box holds a draft:
     with a key saved *and* an edit typed over it, "A custom API key is saved"
     is both true and misleading, and nothing on the page says the stored key is
     not the one in the field. Three states, and an unsaved draft outranks the
     saved one — that is the one a user is about to act on.

     Derived from storage directly rather than from a mirrored boolean. The
     mirror was only ever written by the Save/Clear handlers, so it went stale
     when storage changed underneath it — another tab saving a key, or
     `clearPersistedSession()` on logout — and this page would keep claiming a
     key was saved after the session had already wiped it. localStorage writes
     do not re-render on their own, but both handlers set the draft and the
     notice, which do, so the derived value is never a render behind. */
  const storedKey = localStorage.getItem(API_KEY_STORAGE_KEY) ?? "";
  const trimmedDraft = apiKeyDraft.trim();
  const keyState: "saved" | "empty" | "unsaved" =
    !trimmedDraft ? (storedKey ? "saved" : "empty") : trimmedDraft === storedKey ? "saved" : "unsaved";

  function handleModelChange(model: string) {
    setSelectedModel(model);
    localStorage.setItem(MODEL_STORAGE_KEY, model);
  }

  function handleSaveApiKey(e: FormEvent) {
    e.preventDefault();
    const key = apiKeyDraft.trim();
    if (!key) {
      setNotice({ type: "error", text: "Enter an API key to save it." });
      return;
    }
    localStorage.setItem(API_KEY_STORAGE_KEY, key);
    setApiKeyDraft("");
    setNotice({ type: "success", text: "API key saved" });
  }

  function handleClearApiKey() {
    localStorage.removeItem(API_KEY_STORAGE_KEY);
    setApiKeyDraft("");
    setNotice({ type: "success", text: "API key cleared" });
  }

  return (
    <div className="page page-column">
      <header className="page-header">
        <h1>Settings</h1>
        <p>Manage your account, model, and API access</p>
      </header>

      <section className="settings-card" aria-label="Profile settings">
        <h2>
          <UserIcon />
          Profile
        </h2>
        <p className="settings-desc">
          Signed in as <strong>{user?.username ?? ""}</strong>
        </p>
        <Link to="/app/profile" className="btn btn-secondary">
          Edit profile
        </Link>
      </section>

      <section className="settings-card" aria-label="Model settings">
        <h2>
          <CpuIcon />
          Model
        </h2>
        <p className="settings-desc">
          Choose the AI model used to answer your questions on the Q&A page.
        </p>

        {isLoadingModels ? (
          <div className="loading">
            <Spinner size={20} label="Loading models" />
          </div>
        ) : (
          <>
            {modelsError && (
              <p className="settings-note" role="alert">
                Couldn&apos;t load available models — showing defaults.
              </p>
            )}
            {models && (
              <div className="settings-model-groups">
                <div className="settings-model-group">
                  <p className="settings-model-group-label">Free models</p>
                  {models.free.map((model) => (
                    <label key={model} className="settings-model-option">
                      <input
                        id={`settings-model-free-${model}`}
                        type="radio"
                        name="qa-model"
                        value={model}
                        checked={selectedModel === model}
                        onChange={() => handleModelChange(model)}
                        autoComplete="off"
                      />
                      <span>{model}</span>
                      {selectedModel === model && (
                        /* Decorative: the radio already reports `checked` to
                           assistive tech, so the glyph is `aria-hidden` and
                           carries the selection visually only. */
                        <span className="settings-model-option-check" aria-hidden="true">
                          ✓
                        </span>
                      )}
                    </label>
                  ))}
                </div>
                <div className="settings-model-group">
                  <p className="settings-model-group-label">Paid models</p>
                  {models.paid.map((model) => (
                    <label key={model} className="settings-model-option">
                      <input
                        id={`settings-model-paid-${model}`}
                        type="radio"
                        name="qa-model"
                        value={model}
                        checked={selectedModel === model}
                        onChange={() => handleModelChange(model)}
                        autoComplete="off"
                      />
                      <span>{model}</span>
                      {selectedModel === model && (
                        /* Decorative: the radio already reports `checked` to
                           assistive tech, so the glyph is `aria-hidden` and
                           carries the selection visually only. */
                        <span className="settings-model-option-check" aria-hidden="true">
                          ✓
                        </span>
                      )}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </section>

      <section className="settings-card" aria-label="API key settings">
        <h2>
          <KeyIcon />
          Custom API key
        </h2>
        <p className="settings-desc">
          Bring your own API key to use with your questions. It is stored only
          in your browser.
        </p>

        <form className="settings-api-key-form" onSubmit={handleSaveApiKey}>
          <div className="form-group">
            <label htmlFor="settings-api-key">Custom API key</label>
            <input
              id="settings-api-key"
              name="settings-api-key"
              type="password"
              value={apiKeyDraft}
              onChange={(e) => setApiKeyDraft(e.target.value)}
              placeholder="sk-..."
              autoComplete="off"
              /* A key is not prose: autocorrect capitalising it or the browser
                 offering a spelling underline would both corrupt it silently. */
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </div>
          <div className="settings-api-key-actions">
            <button type="submit" className="btn btn-primary">
              Save
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleClearApiKey}
              disabled={!storedKey}
            >
              Clear
            </button>
          </div>
        </form>

        <p className="settings-note" role="status">
          {keyState === "saved" && "A custom API key is saved."}
          {keyState === "empty" && "No custom API key saved."}
          {keyState === "unsaved" && "Unsaved changes — press Save to use this key."}
        </p>

        {notice?.type === "success" && (
          <p className="success-message">{notice.text}</p>
        )}
        {notice?.type === "error" && (
          <p className="error-message" role="alert">
            {notice.text}
          </p>
        )}
      </section>
    </div>
  );
}

export default SettingsPage;