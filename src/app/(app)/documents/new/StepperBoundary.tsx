'use client';

import Link from 'next/link';
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  failed: boolean;
  tries: number;
}

/**
 * If anything in the quote steps throws, the owner gets a plain message and a Try again button, never a blank or
 * frozen screen. The draft saves as it goes, so whatever was saved before the problem is kept. Only a short code is
 * logged in the browser, never any of the quote.
 */
export class StepperBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false, tries: 0 };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    console.error(`[quote-stepper] code=QF-CLIENT kind=${(error?.name ?? 'Error').replace(/[^A-Za-z]/g, '').slice(0, 40)}`);
  }

  private retry = () => this.setState((s) => ({ failed: false, tries: s.tries + 1 }));

  render() {
    if (!this.state.failed) return <div key={this.state.tries}>{this.props.children}</div>;
    return (
      <section className="qt-crash" role="alert" aria-labelledby="qt-crash-h">
        <h2 id="qt-crash-h" className="section-title">Something went wrong on this screen</h2>
        <p>Your draft saves as you go, so anything saved before this is kept. Try again, and if it happens again, go back to Home and open the quote from Quotes to finish.</p>
        <p className="hint">Reference for TradesPro Digital: QF-CLIENT</p>
        <div className="qt-crash-actions">
          <button type="button" className="btn btn-primary" onClick={this.retry}>Try again</button>
          <Link href="/" className="btn btn-secondary">Back to Home</Link>
        </div>
      </section>
    );
  }
}
