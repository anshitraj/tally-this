import { Component, type ErrorInfo, type ReactNode } from "react";
import { ArrowLeft, RotateCcw } from "lucide-react";

interface Props {
  children: ReactNode;
  /** Changing this clears a shown error, for example when the person opens another page. */
  resetKey?: string;
  onHome?: () => void;
}

interface State {
  error: Error | null;
  attempt: number;
}

/**
 * A page that throws must never leave a blank screen. People get a plain sentence and two ways
 * forward; the technical message stays behind "Show details".
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Page error", error, info.componentStack);
  }

  componentDidUpdate(previous: Props) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private retry = () => {
    this.setState(state => ({ error: null, attempt: state.attempt + 1 }));
  };

  render() {
    const { error, attempt } = this.state;
    if (!error) return <div key={attempt} className="contents">{this.props.children}</div>;
    return (
      <div className="fv-error-state" role="alert">
        <div className="fv-error-mark" aria-hidden="true">!</div>
        <h1>This page could not open.</h1>
        <p>Your files and results are safe. Try again, or go back to the start.</p>
        <div className="fv-error-actions">
          <button type="button" className="fv-button-primary" onClick={this.retry}>
            <RotateCcw className="h-4 w-4" />
            Try again
          </button>
          {this.props.onHome && (
            <button type="button" className="fv-button-secondary" onClick={this.props.onHome}>
              <ArrowLeft className="h-4 w-4" />
              Go to start
            </button>
          )}
        </div>
        <details className="fv-error-details">
          <summary>Show details</summary>
          <code>{error.message || String(error)}</code>
        </details>
      </div>
    );
  }
}
