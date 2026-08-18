export interface AsyncCloseable {
  close(): Promise<void>;
}

export interface StandaloneTopologyOptions {
  projectDomain: AsyncCloseable;
  synax: AsyncCloseable;
  runtime: AsyncCloseable;
  logger?: AsyncCloseable;
  storage?: AsyncCloseable;
}

export interface EmbeddedTopologyOptions {
  projectDomain: AsyncCloseable;
  synax: AsyncCloseable;
  runtime: AsyncCloseable;
}

export interface RemoteTopologyOptions {
  runtimeClient: AsyncCloseable;
  pluginAdminClient?: AsyncCloseable;
}

export interface StandaloneCortxTopology extends AsyncCloseable {
  readonly kind: 'standalone';
  readonly projectDomain: AsyncCloseable;
  readonly synax: AsyncCloseable;
  readonly runtime: AsyncCloseable;
}

export interface EmbeddedCortxTopology extends AsyncCloseable {
  readonly kind: 'embedded';
  readonly projectDomain: AsyncCloseable;
  readonly synax: AsyncCloseable;
  readonly runtime: AsyncCloseable;
}

export interface RemoteCortxTopology extends AsyncCloseable {
  readonly kind: 'remote';
  readonly runtimeClient: AsyncCloseable;
  readonly pluginAdminClient?: AsyncCloseable;
}

export function createStandaloneCortxTopology(options: StandaloneTopologyOptions): StandaloneCortxTopology {
  const close = onceAsync(() => closeOwners('standalone topology', [options.runtime, options.synax, options.projectDomain, options.logger, options.storage]));
  return {
    kind: 'standalone',
    projectDomain: options.projectDomain,
    synax: options.synax,
    runtime: options.runtime,
    close,
  };
}

export function createEmbeddedCortxTopology(options: EmbeddedTopologyOptions): EmbeddedCortxTopology {
  const close = onceAsync(() => closeOwners('embedded topology', [options.runtime, options.synax]));
  return {
    kind: 'embedded',
    projectDomain: options.projectDomain,
    synax: options.synax,
    runtime: options.runtime,
    close,
  };
}

export function createRemoteCortxTopology(options: RemoteTopologyOptions): RemoteCortxTopology {
  const close = onceAsync(() => closeOwners('remote topology', [options.runtimeClient, options.pluginAdminClient]));
  return {
    kind: 'remote',
    runtimeClient: options.runtimeClient,
    pluginAdminClient: options.pluginAdminClient,
    close,
  };
}

function onceAsync(close: () => Promise<void>): () => Promise<void> {
  let result: Promise<void> | undefined;
  return () => (result ??= close());
}

async function closeOwners(label: string, owners: Array<AsyncCloseable | undefined>): Promise<void> {
  const errors: unknown[] = [];
  for (const owner of owners) {
    if (!owner) continue;
    try {
      await owner.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, `${label} close failed`);
}
