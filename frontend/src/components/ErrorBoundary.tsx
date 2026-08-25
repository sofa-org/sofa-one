import { Component, type ReactNode, type ErrorInfo } from 'react';
import { AlertCircle, Home, RotateCcw } from 'lucide-react';

import { CopyButton } from './CopyButton';

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

  private openDashboard = () => {
    window.location.assign('/dashboard');
  };

  private getErrorDetails(error: Error) {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const details = [
      `Time: ${new Date().toISOString()}`,
      `Time zone: ${timeZone ?? 'Unknown'}`,
      `Path: ${window.location.pathname}${window.location.search}${window.location.hash}`,
      `Browser: ${navigator.userAgent}`,
      `Language: ${navigator.language}`,
      `Error: ${error.name}: ${error.message}`,
    ];

    if (import.meta.env.DEV && error.stack) {
      details.push('', error.stack);
    }

    return details.join('\n');
  }

  render() {
    if (this.state.error) {
      const errorDetails = this.getErrorDetails(this.state.error);

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
              <div className="flex items-center justify-center gap-2 rounded-lg bg-white/70 px-3 py-2 text-xs text-red-700">
                <span>Copy error details when contacting support.</span>
                <CopyButton text={errorDetails} />
              </div>
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
                onClick={this.openDashboard}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-red-200 bg-white px-4 py-2 text-sm font-medium text-red-700 transition-colors hover:bg-red-100"
              >
                <Home className="h-4 w-4" />
                Back to dashboard
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
