import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

/**
 * Localized error boundary for the home page's lazy-loaded modules.
 * A failure in one section (chunk load error, recharts render bug,
 * etc.) shouldn't black out the whole page — wrap each big section so
 * the rest keeps working.
 *
 * Logs to console only; if we wire up Sentry / a real reporter later,
 * `componentDidCatch` is the place to call it.
 */
interface State {
  error: Error | null;
}

interface Props {
  /** Short label shown in the fallback ("Calendar", "Inbox", etc.). */
  section: string;
  children: ReactNode;
}

export class HomeErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error(`[home/${this.props.section}] crashed:`, error, info);
  }

  handleReset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <div
          role="alert"
          className="flex flex-col items-start gap-2 rounded-lg border border-red/40 bg-red-soft/40 px-4 py-3 text-[12.5px] text-ink"
        >
          <div className="flex items-center gap-1.5 font-semibold">
            <AlertTriangle size={14} className="text-red" />
            {this.props.section} failed to load
          </div>
          <div className="text-[11.5px] text-ink-3">
            {this.state.error.message || "Unknown error"}
          </div>
          <button
            type="button"
            onClick={this.handleReset}
            className="rounded border border-border-strong bg-surface px-2 py-1 text-[11px] font-medium text-ink-2 hover:bg-surface-2"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
