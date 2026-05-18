import { Component, type ReactNode, type ErrorInfo } from 'react';
import { AlertCircle, RotateCcw } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Unhandled render error', error, info.componentStack);
  }

  private reloadPage = () => {
    window.location.reload();
  };

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen items-center justify-center p-8">
          <div className="flex max-w-md flex-col items-center gap-4 rounded-2xl border border-red-200 bg-red-50 p-8 text-center shadow-sm">
            <AlertCircle className="h-10 w-10 text-red-500" />
            <div className="space-y-2">
              <h1 className="text-lg font-semibold text-red-800">Something went wrong</h1>
              <p className="text-sm text-red-600">
                The dashboard hit an unexpected error. Try reloading the app; if it keeps happening, contact support.
              </p>
              {import.meta.env.DEV && (
                <p className="rounded-lg bg-white/70 px-3 py-2 text-left text-xs text-red-700">
                  {this.state.error.message}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                onClick={this.reloadPage}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-red-800 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700"
              >
                <RotateCcw className="h-4 w-4" />
                Reload app
              </button>
              <button
                onClick={() => this.setState({ error: null })}
                className="rounded-lg border border-red-200 bg-white px-4 py-2 text-sm font-medium text-red-700 transition-colors hover:bg-red-100"
              >
                Try without reload
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
