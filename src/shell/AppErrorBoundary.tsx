import { Component, type ReactNode } from 'react';
import { recordCrash } from '../core/crashLog';

export class AppErrorBoundary extends Component<
  { children: ReactNode; tool: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) {
    recordCrash({ source: 'boundary', message: error.message,
      stack: error.stack, tool: this.props.tool });
  }
  render() {
    if (this.state.failed) return (
      <div className='tool-failure'>This panel failed. The rest of the app is safe.
        <button onClick={() => this.setState({ failed: false })}>Retry</button>
      </div>);
    return this.props.children;
  }
}

// In main.tsx, installed once before any feature module loads:
window.addEventListener('error', (e) =>
  recordCrash({ source: 'window.onerror', message: e.message }));
window.addEventListener('unhandledrejection', (e) =>
  recordCrash({ source: 'unhandledrejection', message: String(e.reason) }));
// Wrap every ribbon panel: <AppErrorBoundary tool='clash'> ... </AppErrorBoundary>
