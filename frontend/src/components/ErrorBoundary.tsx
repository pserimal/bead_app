import { Component, type ReactNode } from 'react';
import Button from './Button';

interface Props { children: ReactNode; }
interface State { hasError: boolean; error: Error | null; }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };
  static getDerivedStateFromError(error: Error) { return { hasError: true, error }; }
  handleRetry = () => this.setState({ hasError: false, error: null });
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center min-h-[50vh]">
          <div className="text-center">
            <div className="text-4xl mb-4">⚠️</div>
            <h2 className="text-lg font-semibold text-slate-700 mb-2">出错了</h2>
            <p className="text-sm text-slate-500 mb-4">{this.state.error?.message || '未知错误'}</p>
            <Button onClick={this.handleRetry}>重试</Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
