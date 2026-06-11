// P3-USERS — canonical user display identity.
//
// Wherever a user is shown as an owner/actor, use this helper so
// deleted users render as the canonical "Deleted user" label and named
// users show their real name with email secondary.

export const DELETED_USER_LABEL = "Deleted user";

export function displayUserName(user: {
  name?: string | null;
  email?: string | null;
  deletedAt?: Date | string | null;
}): string {
  if (user.deletedAt) return DELETED_USER_LABEL;
  const name = user.name?.trim();
  if (name) return name;
  return user.email ?? "Unknown user";
}

/** Tombstone email written when a user is deleted — unique per user so
 *  the lower(email) unique index never collides. */
export function deletedUserTombstoneEmail(userId: string): string {
  return `deleted+${userId}@deleted.luma.local`;
}
