/**
 * Register the Node-side tasks the browser commands call. Use in `setupNodeEvents`:
 *
 *     setupNodeEvents(on, config) { registerSkiplinkTasks(on, config); }
 */
export function registerSkiplinkTasks(
  on: (event: 'task', tasks: Record<string, (arg: any) => unknown>) => void,
  config?: unknown,
): typeof on;
