import { Component, type ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert.tsx';

// A version saved in an older shape must not take the whole panel down with it.
// The stage that cannot render says so; everything else stays usable.
export class StageBoundary extends Component<
  { children: ReactNode; stage: string },
  { error?: string }
> {
  state: { error?: string } = {};
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  componentDidUpdate(previous: { children: ReactNode; stage: string }) {
    if (previous.stage !== this.props.stage && this.state.error)
      this.setState({ error: undefined });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <Alert variant="destructive" role="alert" className="my-4">
        <AlertTitle>Этап не удалось показать</AlertTitle>
        <AlertDescription>
          Скорее всего, версия сохранена в прежней форме и несовместима с текущей схемой. Сохраните
          новую версию этапа — предыдущие остаются в истории. Причина: {this.state.error}
        </AlertDescription>
      </Alert>
    );
  }
}
