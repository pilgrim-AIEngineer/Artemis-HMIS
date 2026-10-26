/** Synthetic E2E accounts, created by `start-e2e-server.ts` in a throwaway database. */
export const E2E_PASSWORD = 'e2e-pass-2026';

export const E2E_USERS = {
  reception: {
    username: 'e2e_reception',
    fullName: 'E2E Reception',
    pin: '2580',
    roles: ['reception'],
  },
  assistant: {
    username: 'e2e_assistant',
    fullName: 'E2E Assistant',
    pin: '2468',
    roles: ['doctor_assistant'],
  },
  // Billing desk: holds billing.bill.cancel and billing.refund.create but not discount.approve.
  cashier: { username: 'e2e_cashier', fullName: 'E2E Cashier', pin: '4826', roles: ['cashier'] },
  admin: { username: 'e2e_admin', fullName: 'E2E Admin', pin: '1357', roles: ['admin'] },
  // Holds queue.display.manage (the waiting-room TV link); admins do not by default.
  owner: { username: 'e2e_owner', fullName: 'E2E Owner', pin: '3691', roles: ['owner'] },
} as const;
