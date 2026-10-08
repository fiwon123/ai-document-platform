import { useState, useOptimistic, useTransition } from "react";
import type { FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { webhooks } from "../services/api";
import type { WebhookEvent, WebhookSubscription } from "../types";
import { Spinner } from "../components/Spinner";
import { Badge } from "../components/Badge";
import { useWebhooks, WEBHOOKS_QUERY_KEY } from "../hooks/useWebhooks";
import { CodeBlock } from "../components/CodeBlock";

const EVENT_OPTIONS: { value: WebhookEvent; label: string }[] = [
  { value: "document.processing", label: "Processing started" },
  { value: "document.ready", label: "Processing finished" },
  { value: "document.failed", label: "Processing failed" },
  { value: "document.deleted", label: "Document deleted" },
];

const PY_VERIFY_SNIPPET = `import hashlib
import hmac

def verify(secret: str, raw_body: bytes, signature: str) -> bool:
    expected = hmac.new(
        secret.encode(), raw_body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature)`;

const JS_VERIFY_SNIPPET = `const crypto = require("crypto");

function verify(secret, rawBody, signature) {
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(signature, "hex"),
  );
}`;

interface Notice {
  type: "success" | "error";
  text: string;
}

type OptimisticSubscriptionAction =
  | { type: "create"; sub: WebhookSubscription }
  | { type: "toggle"; sub: WebhookSubscription }
  | { type: "delete"; id: string };

export function WebhooksPage() {
  const queryClient = useQueryClient();
  const webhooksQuery = useWebhooks();
  const subscriptions = webhooksQuery.data ?? [];
  // Optimistic layer: mutations apply instantly on top of the query data and
  // are dropped again once the real cache update (or a failure) lands.
  const [optimisticSubs, addOptimistic] = useOptimistic(
    subscriptions,
    (state, action: OptimisticSubscriptionAction) => {
      switch (action.type) {
        case "create":
          return [action.sub, ...state];
        case "toggle":
          return state.map((s) => (s.id === action.sub.id ? action.sub : s));
        case "delete":
          return state.filter((s) => s.id !== action.id);
      }
    },
  );
  // addOptimistic must run inside an action (async transition) for React to
  // re-render optimistically.
  const [, startTransition] = useTransition();
  const isLoading = webhooksQuery.isPending && !webhooksQuery.data;
  const loadError = webhooksQuery.isError ? (webhooksQuery.error as Error).message : null;

  const [urlDraft, setUrlDraft] = useState("");
  const [selectedEvents, setSelectedEvents] = useState<WebhookEvent[]>(["document.ready"]);
  const [isCreating, setIsCreating] = useState(false);
  const [creatingError, setCreatingError] = useState<string | null>(null);

  const [notice, setNotice] = useState<Notice | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  /* `{ message, at }`, not a bare string (#588). A test ping that reported only
     its message could not be told apart from one sent minutes earlier — the
     card's own "Last delivered" row updates on a *different* schedule, so
     "delivered 3 minutes ago" next to an undated "Test: ok" reads as a
     contradiction rather than as two events. The time is taken when the
     response arrives. */
  const [testResults, setTestResults] = useState<Record<string, { message: string; at: Date }>>({});
  // The "How webhooks work" card auto-expands while the user has no
  // subscriptions and collapses as soon as they create one. Closing it
  // manually stays respected even with an empty list.
  const [tutorialDismissed, setTutorialDismissed] = useState(false);
  const hasSubscriptions = optimisticSubs.length > 0;

  function toggleEvent(event: WebhookEvent) {
    setSelectedEvents((current) =>
      current.includes(event) ? current.filter((e) => e !== event) : [...current, event],
    );
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    const url = urlDraft.trim();
    if (!url) {
      setCreatingError("Enter the receiver URL.");
      return;
    }
    if (selectedEvents.length === 0) {
      setCreatingError("Select at least one event.");
      return;
    }
    setCreatingError(null);
    startTransition(async () => {
      // Placeholder card while the request is in flight; replaced by the
      // real subscription once the server responds.
      const placeholder: WebhookSubscription = {
        id: `pending-${Date.now()}`,
        url,
        events: selectedEvents,
        is_active: true,
        secret: "",
        last_status: null,
        last_status_code: null,
        last_delivered_at: null,
        failure_count: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      addOptimistic({ type: "create", sub: placeholder });
      setIsCreating(true);
      try {
        const created = await webhooks.create(url, selectedEvents);
        queryClient.setQueryData<WebhookSubscription[]>(WEBHOOKS_QUERY_KEY, (prev) => [
          created,
          ...(prev ?? []),
        ]);
        setUrlDraft("");
        setSelectedEvents(["document.ready"]);
        setNotice({ type: "success", text: "Webhook created" });
      } catch (err: unknown) {
        setCreatingError(err instanceof Error ? err.message : "Failed to create webhook");
      } finally {
        setIsCreating(false);
      }
    });
  }

  function handleToggleActive(sub: WebhookSubscription) {
    startTransition(async () => {
      addOptimistic({
        type: "toggle",
        sub: { ...sub, is_active: !sub.is_active },
      });
      try {
        const updated = await webhooks.update(sub.id, { is_active: !sub.is_active });
        queryClient.setQueryData<WebhookSubscription[]>(WEBHOOKS_QUERY_KEY, (prev) =>
          (prev ?? []).map((s) => (s.id === updated.id ? updated : s)),
        );
      } catch (err: unknown) {
        setNotice({
          type: "error",
          text: err instanceof Error ? err.message : "Failed to update webhook",
        });
      }
    });
  }

  function handleDelete(sub: WebhookSubscription) {
    if (!confirm(`Delete the webhook for "${sub.url}"?`)) return;
    startTransition(async () => {
      addOptimistic({ type: "delete", id: sub.id });
      try {
        await webhooks.remove(sub.id);
        queryClient.setQueryData<WebhookSubscription[]>(WEBHOOKS_QUERY_KEY, (prev) =>
          (prev ?? []).filter((s) => s.id !== sub.id),
        );
        setNotice({ type: "success", text: "Webhook deleted" });
      } catch (err: unknown) {
        setNotice({
          type: "error",
          text: err instanceof Error ? err.message : "Failed to delete webhook",
        });
      }
    });
  }

  async function handleTest(sub: WebhookSubscription) {
    setTestingId(sub.id);
    try {
      const result = await webhooks.test(sub.id);
      setTestResults((current) => ({
        ...current,
        [sub.id]: { message: result.message, at: new Date() },
      }));
      // Reflect the updated delivery stats in the listing.
      void queryClient.invalidateQueries({ queryKey: WEBHOOKS_QUERY_KEY });
    } catch (err: unknown) {
      setTestResults((current) => ({
        ...current,
        [sub.id]: {
          message: err instanceof Error ? err.message : "Test failed",
          at: new Date(),
        },
      }));
    } finally {
      setTestingId(null);
    }
  }

  return (
    <div className="page page-column page-column--wide">
      <header className="page-header">
        <h1>Webhooks</h1>
        <p>Get notified when your documents change processing state</p>
      </header>

      <details
        className="webhook-tutorial forced-dark"
        open={!hasSubscriptions && !tutorialDismissed}
        onToggle={(e) => {
          // Remember manual closes so an empty list does not force the card
          // back open on every visit.
          if (!(e.currentTarget as HTMLDetailsElement).open) {
            setTutorialDismissed(true);
          }
        }}
      >
        <summary>
          <span className="webhook-tutorial-title">How webhooks work</span>
          <span className="webhook-tutorial-hint">3 steps · ~2 min</span>
        </summary>

        <ol className="webhook-steps">
          <li>
            <span className="webhook-step-num">1</span>
            <div>
              <strong>Create a subscription</strong>
              <p>
                Paste the receiver URL that accepts HTTP POST requests and pick the events that
                matter to you — for example <code>document.ready</code>.
              </p>
            </div>
          </li>
          <li>
            <span className="webhook-step-num">2</span>
            <div>
              <strong>We deliver signed events</strong>
              <p>
                Whenever one of those events fires, we POST the JSON payload to your URL with the{" "}
                <code>X-Webhook-Signature</code> header — an HMAC-SHA256 of the raw request body
                signed with your subscription secret.
              </p>
            </div>
          </li>
          <li>
            <span className="webhook-step-num">3</span>
            <div>
              <strong>Verify before you trust</strong>
              <p>
                Recompute the HMAC on your side and compare it with the signature. If they match,
                the payload really came from the platform and was not tampered with.
              </p>
            </div>
          </li>
        </ol>

        <div className="webhook-snippets forced-dark">
          <details className="webhook-snippet">
            <summary>Verify in Python (FastAPI / Flask)</summary>
            <CodeBlock code={PY_VERIFY_SNIPPET} language="python" />
          </details>
          <details className="webhook-snippet">
            <summary>Verify in JavaScript (Node / Express)</summary>
            <CodeBlock code={JS_VERIFY_SNIPPET} language="javascript" />
          </details>
        </div>
      </details>

      <section className="settings-card forced-dark">
        <h2>New webhook</h2>
        <p className="settings-desc">
          Receive a signed HTTP POST whenever a document event occurs. Verify payloads with the{" "}
          <code>X-Webhook-Signature</code> header (HMAC-SHA256 of the raw body using your
          subscription secret).
        </p>

        <form className="webhook-form" onSubmit={handleCreate}>
          <label className="webhook-field">
            <span>Receiver URL</span>
            <input
              id="webhook-url"
              name="webhook-url"
              type="url"
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              placeholder="https://example.com/hook"
              autoComplete="url"
            />
          </label>

          <fieldset className="webhook-events">
            <legend>Events</legend>
            <div className="webhook-event-options">
              {EVENT_OPTIONS.map((option) => (
                <label key={option.value} className="webhook-event-option">
                  <input
                    id={`webhook-event-${option.value}`}
                    name="webhook-events"
                    type="checkbox"
                    checked={selectedEvents.includes(option.value)}
                    onChange={() => toggleEvent(option.value)}
                    autoComplete="off"
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>

          {creatingError && (
            <p className="settings-note" role="alert">
              {creatingError}
            </p>
          )}
          <button type="submit" className="btn btn-primary" disabled={isCreating}>
            {isCreating ? "Creating…" : "Create webhook"}
          </button>
        </form>
      </section>

      {notice && (
        <p className={`settings-note webhook-notice-${notice.type}`} role="status">
          {notice.text}
        </p>
      )}

      <section className="webhook-list" aria-label="Webhook subscriptions">
        {isLoading ? (
          <div className="loading">
            <Spinner size={20} label="Loading webhooks" />
          </div>
        ) : loadError ? (
          <p className="settings-note" role="alert">
            {loadError}
          </p>
        ) : optimisticSubs.length === 0 ? (
          <p className="settings-note">
            No webhooks yet — create one above to receive document events.
          </p>
        ) : (
          optimisticSubs.map((sub) => {
            /* Read once: re-indexing `testResults[sub.id]` inside the JSX loses
               the narrowing that the `&&` guard established. */
            const testResult = testResults[sub.id];
            return (
              <article key={sub.id} className="settings-card webhook-card forced-dark">
                <div className="webhook-card-header">
                  <code className="webhook-url">{sub.url}</code>
                  <Badge tone={sub.is_active ? "green" : "gray"}>
                    {sub.is_active ? "Active" : "Paused"}
                  </Badge>
                </div>

                <div className="webhook-events-tags">
                  {sub.events.map((event) => (
                    <span key={event} className="webhook-event-tag">
                      {event}
                    </span>
                  ))}
                </div>

                <dl className="webhook-meta">
                  <div>
                    <dt>Last delivery</dt>
                    <dd className={sub.last_status === "failed" ? "webhook-delivery-failed" : ""}>
                      {sub.last_status === null
                        ? "Never"
                        : `${sub.last_status}${sub.last_status_code ? ` (HTTP ${sub.last_status_code})` : ""}`}
                    </dd>
                  </div>
                  <div>
                    <dt>Consecutive failures</dt>
                    <dd>{sub.failure_count}</dd>
                  </div>
                  <div>
                    <dt>Last delivered</dt>
                    <dd>
                      {sub.last_delivered_at
                        ? new Date(sub.last_delivered_at).toLocaleString()
                        : "—"}
                    </dd>
                  </div>
                </dl>

                <details className="webhook-secret">
                  <summary>Show signing secret</summary>
                  <code>{sub.secret}</code>
                </details>

                <div className="webhook-actions">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => handleToggleActive(sub)}
                  >
                    {sub.is_active ? "Pause" : "Resume"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => handleTest(sub)}
                    disabled={testingId === sub.id}
                  >
                    {testingId === sub.id ? "Sending…" : "Send test"}
                  </button>
                  {/* Inline with the button that produced it, and carrying when.
                      `role="status"` announces it when it lands, without moving
                      focus. */}
                  {testResult && (
                    <span className="webhook-test-result" role="status">
                      <span className="webhook-test-result-time">
                        Test sent {testResult.at.toLocaleTimeString()}
                      </span>
                      <span className="webhook-test-result-message">{testResult.message}</span>
                    </span>
                  )}
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    onClick={() => handleDelete(sub)}
                  >
                    Delete
                  </button>
                </div>
              </article>
            );
          })
        )}
      </section>
    </div>
  );
}
