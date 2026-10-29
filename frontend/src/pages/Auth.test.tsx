import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CustomerAuthProvider } from '../lib/auth';
import { LoginPage } from './AuthPages';

function mockFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { const r = handler(url, init); return { ok: r.status < 400, status: r.status, json: async () => r.body } as Response; }));
}
afterEach(() => vi.unstubAllGlobals());

describe('customer login page', () => {
  it('shows the server error for wrong credentials and never calls the admin endpoint', async () => {
    const calls: string[] = [];
    mockFetch((url) => {
      calls.push(url);
      if (url.endsWith('/auth/me')) return { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'x' } } };
      return { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'Incorrect email or password.' } } };
    });
    render(<MemoryRouter><CustomerAuthProvider><LoginPage /></CustomerAuthProvider></MemoryRouter>);
    await userEvent.type(await screen.findByLabelText('Email'), 'a@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'wrongpass1');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect email or password.');
    await waitFor(() => expect(calls.some((u) => u.includes('/api/auth/login'))).toBe(true));
    expect(calls.some((u) => u.includes('/admin/'))).toBe(false);
  });
  it('does not offer any admin link', async () => {
    mockFetch(() => ({ status: 401, body: {} }));
    render(<MemoryRouter><CustomerAuthProvider><LoginPage /></CustomerAuthProvider></MemoryRouter>);
    await screen.findByLabelText('Email');
    expect(document.querySelector('a[href^="/admin"]')).toBeNull();
  });
});
