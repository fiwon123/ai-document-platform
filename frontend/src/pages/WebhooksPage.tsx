import { useState, useOptimistic, useTransition } from "react";
import type { FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { webhooks } from "../services/api";
import type { WebhookEvent, WebhookSubscription } from "../types";
import { Spinner } from "../components/Spinner";
import { Badge } from "../components/Badge";
import { useWebhooks, WEBHOOKS_QUERY_KEY } from "../hooks/useWebhooks";

const EVENT_OPTIONS: { value: WebhookEvent; label: string }[] = [
  { value: "document.processing", label: "Processing started" },
  { value: "document.ready", label: "Processing finished" },
  { value: "document.failed", label: "Processing failed" },
  { value: "document.deleted", label: "Document deleted" },
];

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
  const loadError = webhooksQuery.isError
    ? (webhooksQuery.error as Error).message
    : null;

  const [urlDraft, setUrlDraft] = useState("");
  const [selectedEvents, setSelectedEvents] = useState<WebhookEvent[]>([
    "document.ready",
  ]);
  const [isCreating, setIsCreating] = useState(false);
  const [creatingError, setCreatingError] = useState<string | null>(null);

  const [notice, setNotice] = useState<Notice | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, string>>({});

  function toggleEvent(event: WebhookEvent) {
    setSelectedEvents((current) =>
      current.includes(event)
        ? current.filter((e) => e !== event)
        : [...current, event],
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
        [sub.id]: result.message,
      }));
      // Reflect the updated delivery stats in the listing.
      void queryClient.invalidateQueries({ queryKey: WEBHOOKS_QUERY_KEY });
    } catch (err: unknown) {
      setTestResults((current) => ({
        ...current,
        [sub.id]: err instanceof Error ? err.message : "Test failed",
      }));
    } finally {
      setTestingId(null);
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Webhooks</h1>
        <p>Get notified when your documents change processing state</p>
      </header>

      <section className="settings-card">
        <h2>New webhook</h2>
        <p className="settings-desc">
          Receive a signed HTTP POST whenever a document event occurs. Verify
          payloads with the <code>X-Webhook-Signature</code> header
          (HMAC-SHA256 of the raw body using your subscription secret).
        </p>

        <form className="webhook-form" onSubmit={handleCreate}>
          <label className="webhook-field">
            <span>Receiver URL</span>
            <input
              type="url"
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              placeholder="https://example.com/hook"
            />
          </label>

          <fieldset className="webhook-events">
            <legend>Events</legend>
            <div className="webhook-event-options">
              {EVENT_OPTIONS.map((option) => (
                <label key={option.value} className="webhook-event-option">
                  <input
                    type="checkbox"
                    checked={selectedEvents.includes(option.value)}
                    onChange={() => toggleEvent(option.value)}
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
          <button
            type="submit"
            className="btn btn-primary"
            disabled={isCreating}
          >
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
          optimisticSubs.map((sub) => (
            <article key={sub.id} className="settings-card webhook-card">
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
                  <dd
                    className={
                      sub.last_status === "failed" ? "webhook-delivery-failed" : ""
                    }
                  >
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
                  <dd>{sub.last_delivered_at ? new Date(sub.last_delivered_at).toLocaleString() : "—"}</dd>
                </div>
              </dl>

              <details className="webhook-secret">
                <summary>Show signing secret</summary>
                <code>{sub.secret}</code>
              </details>

              {testResults[sub.id] && (
                <p className="settings-note" role="status">
                  Test: {testResults[sub.id]}
                </p>
              )}

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
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  onClick={() => handleDelete(sub)}
                >
                  Delete
                </button>
              </div>
            </article>
          ))
        )}
      </section>
    </div>
  );
}