/**
 * Error boundary around a tab's content. A tab renderer that throws (e.g. the
 * 3D tab when `new THREE.WebGLRenderer()` fails because the browser can't create
 * a WebGL context) would otherwise unmount the whole React tree and leave a
 * blank window. This catches it so the rest of the app — top bar, tab bar, the
 * other tabs — keeps working, and the offending tab shows a useful message.
 *
 * Error boundaries must be class components (no hook equivalent for
 * componentDidCatch / getDerivedStateFromError).
 */

import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class TabErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error('[TabErrorBoundary] tab crashed:', error);
  }

  private reset = () => this.setState({ error: null });

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const isWebGL = /webgl|context creating|creating webgl/i.test(error.message);

    return (
      <div className="tab-error">
        <h2>This tab hit an error</h2>
        {isWebGL ? (
          <p>
            WebViz couldn’t create a WebGL context, so the 3D view can’t render.
            This usually means hardware acceleration is disabled in your browser.
            In Chrome: open <code>chrome://gpu</code> to check the WebGL status,
            enable <em>“Use graphics acceleration when available”</em> in{' '}
            <code>chrome://settings/system</code>, then relaunch. Forcing{' '}
            <em>“Override software rendering list”</em> in <code>chrome://flags</code>{' '}
            also works as a software fallback.
          </p>
        ) : (
          <p>The rest of the app is still running; other tabs are unaffected.</p>
        )}
        <pre className="tab-error-msg">{error.message}</pre>
        <button onClick={this.reset}>Try again</button>
      </div>
    );
  }
}
