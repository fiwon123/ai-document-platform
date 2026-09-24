import { useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import type { QAModels } from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useQAModels } from "../hooks/useQAModels";
import { Spinner } from "../components/Spinner";

const MODEL_STORAGE_KEY = "askdocs-model";
const API_KEY_STORAGE_KEY = "askdocs-api-key";

/** Shown when the models endpoint is unavailable so the page never breaks. */
const DEFAULT_MODELS: QAModels = {
  free: ["gpt-4o-mini"],
  paid: ["gpt-4o", "gpt-4", "gpt-4-turbo"],
};

interface Notice {
  type: "success" | "error";
  text: string;
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
    () => localStorage.getItem(MODEL_STORAGE_KEY) ?? DEFAULT_MODELS.free[0] ?? "gpt-4o-mini",
  );
  const [hasApiKey, setHasApiKey] = useState<boolean>(() =>
    Boolean(localStorage.getItem(API_KEY_STORAGE_KEY)),
  );
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);

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
    setHasApiKey(true);
    setApiKeyDraft("");
    setNotice({ type: "success", text: "API key saved" });
  }

  function handleClearApiKey() {
    localStorage.removeItem(API_KEY_STORAGE_KEY);
    setHasApiKey(false);
    setApiKeyDraft("");
    setNotice({ type: "success", text: "API key cleared" });
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Settings</h1>
        <p>Manage your account, model, and API access</p>
      </header>

      <section className="settings-card">
        <h2>Profile</h2>
        <p className="settings-desc">
          Signed in as <strong>{user?.username ?? ""}</strong>
        </p>
        <Link to="/app/profile" className="btn btn-secondary">
          Edit profile
        </Link>
      </section>

      <section className="settings-card">
        <h2>Model</h2>
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
                        type="radio"
                        name="qa-model"
                        value={model}
                        checked={selectedModel === model}
                        onChange={() => handleModelChange(model)}
                      />
                      <span>{model}</span>
                    </label>
                  ))}
                </div>
                <div className="settings-model-group">
                  <p className="settings-model-group-label">Paid models</p>
                  {models.paid.map((model) => (
                    <label key={model} className="settings-model-option">
                      <input
                        type="radio"
                        name="qa-model"
                        value={model}
                        checked={selectedModel === model}
                        onChange={() => handleModelChange(model)}
                      />
                      <span>{model}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </section>

      <section className="settings-card">
        <h2>Custom API key</h2>
        <p className="settings-desc">
          Bring your own API key to use with your questions. It is stored only
          in your browser.
        </p>

        <form className="settings-api-key-form" onSubmit={handleSaveApiKey}>
          <div className="form-group">
            <label htmlFor="settings-api-key">Custom API key</label>
            <input
              id="settings-api-key"
              type="password"
              value={apiKeyDraft}
              onChange={(e) => setApiKeyDraft(e.target.value)}
              placeholder="sk-..."
              autoComplete="off"
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
              disabled={!hasApiKey}
            >
              Clear
            </button>
          </div>
        </form>

        {hasApiKey && <p className="settings-note">A custom API key is saved.</p>}

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