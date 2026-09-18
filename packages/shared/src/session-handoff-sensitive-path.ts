const SENSITIVE_EXTENSIONS = [
  '.key',
  '.pem',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.kdbx',
  '.ovpn',
  '.ppk',
  '.tfstate',
] as const;

const SENSITIVE_FILENAMES = new Set([
  '.envrc',
  '.git-credentials',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'auth.json',
  'credentials',
  'credentials.json',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
]);

const SENSITIVE_DIRECTORIES = new Set(['.aws', '.azure', '.docker', '.kube', '.ssh']);

export function isSensitiveHandoffPath(relativePath: string): boolean {
  const lower = relativePath.replaceAll('\\', '/').toLowerCase();
  const segments = lower.split('/');
  const basename = segments.at(-1) ?? lower;
  return (
    basename === '.env' ||
    basename.startsWith('.env.') ||
    basename.includes('credential') ||
    /^(?:client[-_]?secret|service[-_]?account)(?:[-_.].*)?\.json$/u.test(basename) ||
    basename.includes('secret') ||
    SENSITIVE_FILENAMES.has(basename) ||
    segments.some((segment) => SENSITIVE_DIRECTORIES.has(segment)) ||
    SENSITIVE_EXTENSIONS.some((extension) => basename.endsWith(extension))
  );
}
