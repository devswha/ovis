/** A value as one shell word that sh takes literally (term.sh evals these lines): single-quoted, each ' as '\''. */
export const shellQuoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
