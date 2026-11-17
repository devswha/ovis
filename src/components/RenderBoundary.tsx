import { Component, type ReactNode } from "react";

interface Props {
  resetKey: unknown;
  fallback: (retry: () => void, error: unknown) => ReactNode;
  children: ReactNode;
}

interface State { failed: boolean; key: unknown; error?: unknown }

export class RenderBoundary extends Component<Props, State> {
  override state: State = { failed: false, key: this.props.resetKey };

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.key ? { failed: false, key: props.resetKey } : null;
  }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { failed: true, error };
  }

  override componentDidCatch(error: unknown): void {
    console.error("render failed", error);
  }

  private retry = (): void => this.setState({ failed: false });

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback(this.retry, this.state.error) : this.props.children;
  }
}
