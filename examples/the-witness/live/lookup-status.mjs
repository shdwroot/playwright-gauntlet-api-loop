export const usableLookupStatuses = Object.freeze(['complete', 'partial']);

export function isUsableLookupStatus(status) {
  return usableLookupStatuses.includes(status);
}
