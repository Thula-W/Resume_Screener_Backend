import { Container, getContainer } from '@cloudflare/containers';

export class MyBackendContainer extends Container {
  defaultPort = 8080;
  sleepAfter = '10m';        // sleeps after 10 min of no requests
  enableInternet = true;     // your container needs to reach Supabase
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Route all requests to a single named container instance
    const container = getContainer(env.MY_BACKEND, 'default');
    return await container.fetch(request);
  },
};

interface Env {
  MY_BACKEND: DurableObjectNamespace<MyBackendContainer>;
}