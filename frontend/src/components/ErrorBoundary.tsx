import { Component, type ReactNode, type ErrorInfo } from 'react';
import { AlertCircle } from 'lucide-react';

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

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen items-center justify-center p-8">
          <div className="flex max-w-md flex-col items-center gap-4 rounded-2xl border border-red-200 bg-red-50 p-8 text-center shadow-sm">
            <AlertCircle className="h-10 w-10 text-red-500" />
            <h1 className="text-lg font-semibold text-red-800">Something went wrong</h1>
            <p className="text-sm text-red-600">{this.state.error.message}</p>
            <button
              onClick={() => this.setState({ error: null })}
              className="rounded-lg bg-red-800 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 transition-colors"
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
