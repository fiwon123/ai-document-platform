import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional label for the fallback card, e.g. the feature name. */
  label?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render/lifecycle errors in the tree below it and shows a recoverable
 * fallback instead of unmounting the whole app. Async errors are NOT caught
 * here — those must be handled with try/catch at the call site.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the error visible to operators without crashing the UI.
    console.error("ErrorBoundary caught an error:", error, info.componentStack);
  }

  private readonly handleRetry = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    const title = this.props.label ?? "Something went wrong";
    return (
      <div className="error-boundary" role="alert">
        <h2>{title}</h2>
        <p>
          An unexpected error occurred while rendering this view. Your data is
          safe — you can retry, or reload the page.
        </p>
        <pre>{error.message}</pre>
        <div className="error-boundary-actions">
          <button type="button" className="btn btn-primary" onClick={this.handleRetry}>
            Try again
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => window.location.reload()}
          >
            Reload page
          </button>
        </div>
      </div>
    );
  }
}