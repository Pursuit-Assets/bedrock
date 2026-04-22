/**
 * Unit tests for useSchemaPicklist.
 *
 * Strategy: mock `apiService.getSchemaDescribe` at the module boundary so
 * no real network call happens. Each test creates a fresh `QueryClient`
 * (retry: false, cacheTime: 0, staleTime: 0) so mocks don't leak between
 * cases via react-query's internal cache.
 */
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from 'react-query';

jest.mock('../services/api', () => ({
  apiService: { getSchemaDescribe: jest.fn() },
}));

import { apiService } from '../services/api';
import { useSchemaPicklist } from './useSchemaPicklist';

const getSchemaDescribe = apiService.getSchemaDescribe as jest.Mock;

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, cacheTime: 0, staleTime: 0 },
    },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

/** Build a raw describe-endpoint response body (matches current backend). */
function rawSchemaResponse(fields: unknown[]) {
  return { data: { sobject: 'Test', fields, recordTypes: [] } };
}

beforeEach(() => {
  getSchemaDescribe.mockReset();
});

describe('useSchemaPicklist', () => {
  it('returns sorted, deduped, active-only picklist values on the happy path', async () => {
    getSchemaDescribe.mockResolvedValue(
      rawSchemaResponse([
        {
          name: 'StageName',
          type: 'picklist',
          picklistValues: [
            { value: 'Solicitation', label: 'Solicitation', active: true },
            { value: 'Awarded', label: 'Awarded', active: true },
            { value: 'Cultivation', label: 'Cultivation', active: true },
            { value: 'Legacy', label: 'Legacy', active: false },
          ],
        },
      ]),
    );

    const { result } = renderHook(
      () => useSchemaPicklist('Opportunity', 'StageName'),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.options).toEqual(['Awarded', 'Cultivation', 'Solicitation']);
    expect(result.current.error).toBeNull();
    expect(getSchemaDescribe).toHaveBeenCalledWith('Opportunity');
    expect(getSchemaDescribe).toHaveBeenCalledTimes(1);
  });

  it('returns empty options when the field name is absent from the response', async () => {
    getSchemaDescribe.mockResolvedValue(
      rawSchemaResponse([
        {
          name: 'SomeOtherField',
          type: 'picklist',
          picklistValues: [{ value: 'X', label: 'X', active: true }],
        },
      ]),
    );

    const { result } = renderHook(
      () => useSchemaPicklist('Opportunity', 'StageName'),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.options).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('returns empty options when the field is not a picklist (no picklistValues)', async () => {
    getSchemaDescribe.mockResolvedValue(
      rawSchemaResponse([
        { name: 'Amount', type: 'currency' }, // intentionally no picklistValues
      ]),
    );

    const { result } = renderHook(
      () => useSchemaPicklist('Opportunity', 'Amount'),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.options).toEqual([]);
  });

  it('returns empty options when every picklist value is inactive', async () => {
    getSchemaDescribe.mockResolvedValue(
      rawSchemaResponse([
        {
          name: 'StageName',
          type: 'picklist',
          picklistValues: [
            { value: 'Legacy-A', label: 'Legacy A', active: false },
            { value: 'Legacy-B', label: 'Legacy B', active: false },
          ],
        },
      ]),
    );

    const { result } = renderHook(
      () => useSchemaPicklist('Opportunity', 'StageName'),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.options).toEqual([]);
  });

  it('deduplicates repeated values (keeps first, drops later copies)', async () => {
    getSchemaDescribe.mockResolvedValue(
      rawSchemaResponse([
        {
          name: 'StageName',
          type: 'picklist',
          picklistValues: [
            { value: 'Awarded', label: 'Awarded', active: true },
            { value: 'Awarded', label: 'Awarded (dup)', active: true },
            { value: 'Cultivation', label: 'Cultivation', active: true },
          ],
        },
      ]),
    );

    const { result } = renderHook(
      () => useSchemaPicklist('Opportunity', 'StageName'),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.options).toEqual(['Awarded', 'Cultivation']);
  });

  it('surfaces error state and returns empty options when the describe request rejects', async () => {
    // Hook forces `retry: 1` (production-mirrored from useOpportunityRecordTypes),
    // which overrides the QueryClient's `retry: false` default. That means the
    // query retries once with ~1s backoff before settling, so default 1s waitFor
    // would time out. Wait on `error` directly with a generous timeout instead.
    const boom = new Error('schema endpoint 500');
    getSchemaDescribe.mockRejectedValue(boom);

    const { result } = renderHook(
      () => useSchemaPicklist('Opportunity', 'StageName'),
      { wrapper: createWrapper() },
    );

    await waitFor(
      () => expect(result.current.error).toBe(boom),
      { timeout: 5000 },
    );
    expect(result.current.options).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(getSchemaDescribe).toHaveBeenCalledTimes(2); // 1 initial + 1 retry
  });

  it('tolerates both raw { fields } and legacy { data: { fields } } envelope shapes', async () => {
    getSchemaDescribe.mockResolvedValue({
      data: {
        success: true,
        data: {
          fields: [
            {
              name: 'Type',
              type: 'picklist',
              picklistValues: [
                { value: 'Grant', label: 'Grant', active: true },
                { value: 'Gift', label: 'Gift', active: true },
              ],
            },
          ],
        },
      },
    });

    const { result } = renderHook(
      () => useSchemaPicklist('Opportunity', 'Type'),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.options).toEqual(['Gift', 'Grant']);
  });
});
