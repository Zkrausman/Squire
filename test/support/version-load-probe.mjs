const personalDirectory = new URL("../../dist/src/personal/", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (resolved.url.startsWith(personalDirectory) && !/\/(?:cli|cli-arguments|runtime-version)\.js$/u.test(resolved.url)) {
    throw new Error(`version command loaded runtime module: ${resolved.url}`);
  }
  return resolved;
}
