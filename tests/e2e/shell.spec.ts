import { expect, test } from '../../web/playwright-fixtures';

test('embedded shell starts over direct HTTP without exposing application routes', async ({
  page,
  request,
}) => {
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Open Video Sync', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Server: ready');
  await page.goto('/join');
  await expect(page.getByRole('status')).toHaveText('Server: ready');
  const api = await request.post('/api/v1/session');
  expect(api.status()).toBe(404);
  expect(api.headers()['content-type']).not.toContain('text/html');
  expect(failures).toEqual([]);
});
