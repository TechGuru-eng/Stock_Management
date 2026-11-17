/**
 * Who is working at the till right now (set by the sign-in layer). Everything recorded for upload is stamped with this
 * person, so that when a shared device uploads later the server credits each record to the right staff member, even if the
 * device itself is signed in under someone else's session.
 */
let current: string | null = null

export const setOutboxActor = (userId: string | null): void => { current = userId }
export const getOutboxActor = (): string | null => current
