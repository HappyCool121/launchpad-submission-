import { readFileSync } from 'node:fs';

const sslQueryParameters = ['sslmode', 'sslcert', 'sslkey', 'sslrootcert'];

export function strictPostgresConnection(connectionString: string, hosted: boolean): {
  connectionString: string;
  ssl: { ca: Buffer; rejectUnauthorized: true } | undefined;
} {
  if (!hosted) return { connectionString, ssl: undefined };

  const database = new URL(connectionString);
  for (const parameter of sslQueryParameters) database.searchParams.delete(parameter);

  return {
    connectionString: database.toString(),
    ssl: {
      ca: readFileSync(new URL('../../certs/prod-ca-2021.crt', import.meta.url)),
      rejectUnauthorized: true,
    },
  };
}
