/** What Home says when a data load fails, so an empty table is never mistaken for lost data. */
export const HOME_LOAD_MESSAGES = {
  jobs: 'Some of your jobs could not be loaded. Refresh to try again.',
  documents: 'Some of your documents could not be loaded. Refresh to try again.',
  today: 'Today could not be loaded. Refresh to try again.',
} as const;
