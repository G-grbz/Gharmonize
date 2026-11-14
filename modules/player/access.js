// Per-user library visibility. A track is visible when its library is enabled
// AND the user may see that library: administrators and users with
// "all libraries" see every enabled library, everybody else only the
// libraries explicitly granted to them.

// SQL fragment; `uidRef` is a bound parameter name (e.g. '$uid') or a numeric
// literal that was already coerced to an integer by the caller.
export function visibleLibrariesSql(uidRef = '$uid') {
  return `(SELECT l.id FROM libraries l WHERE l.enabled = 1 AND (
    EXISTS (SELECT 1 FROM users u WHERE u.id = ${uidRef} AND u.disabled = 0 AND (u.role = 'admin' OR u.all_libraries = 1))
    OR l.id IN (SELECT ul.library_id FROM user_libraries ul WHERE ul.user_id = ${uidRef})))`
}

export function visibleSql(alias = 't', uidRef = '$uid') {
  return `${alias}.library_id IN ${visibleLibrariesSql(uidRef)}`
}

export function uidLiteral(userId) {
  return String(Math.max(0, Math.floor(Number(userId) || 0)))
}

export function createAccess(db) {
  const visibleIds = db.prepare(`SELECT id FROM libraries WHERE id IN ${visibleLibrariesSql('$uid')} ORDER BY id`)
  return {
    visibleLibraryIds: (userId) => visibleIds.all({ $uid: Number(userId) || 0 }).map((r) => r.id),
    canSeeLibrary: (userId, libraryId) => visibleIds.all({ $uid: Number(userId) || 0 }).some((r) => r.id === Number(libraryId))
  }
}
