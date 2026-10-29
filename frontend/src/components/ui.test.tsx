import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Badge, ConfirmDialog, Field, Pager } from './ui';

describe('ui components', () => {
  it('labels booking statuses readably', () => {
    render(<Badge status="approved" />);
    expect(screen.getByText('Approved')).toBeInTheDocument();
  });
  it('associates field labels and shows errors accessibly', () => {
    render(<Field id="email" label="Email" error="Enter a valid email address" />);
    const input = screen.getByLabelText('Email');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Enter a valid email address');
  });
  it('confirm dialog passes the reason and closes', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<ConfirmDialog title="Reject?" message="msg" confirmLabel="Reject" askReason onConfirm={onConfirm} onClose={onClose} />);
    expect(screen.getByRole('dialog', { name: 'Reject?' })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/reason/i), 'Fully booked');
    await userEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onConfirm).toHaveBeenCalledWith('Fully booked');
    expect(onClose).toHaveBeenCalled();
  });
  it('escape closes the dialog', async () => {
    const onClose = vi.fn();
    render(<ConfirmDialog title="T" message="m" confirmLabel="Go" onConfirm={async () => {}} onClose={onClose} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
  it('pager disables edges and reports ranges', async () => {
    const onPage = vi.fn();
    render(<Pager page={1} pageSize={20} total={45} onPage={onPage} />);
    expect(screen.getByText('1–20 of 45')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(onPage).toHaveBeenCalledWith(2);
  });
});
