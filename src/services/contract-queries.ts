import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ContractChange, ReviewState } from '../models/contract';
import {
  addExemption,
  applyContractDefinition,
  bulkReviewChanges,
  confirmDiffSnapshot,
  freezeVersion,
  getContract,
  importContractDocument,
  listContracts,
  reviewChange,
  updateChangeStatements,
} from './contract-service';

export const contractKeys = {
  all: ['contracts'] as const,
  detail: (id: string) => ['contracts', id] as const,
};

export function useContracts() {
  return useQuery({
    queryKey: contractKeys.all,
    queryFn: listContracts,
  });
}

export function useContract(id: string) {
  return useQuery({
    queryKey: contractKeys.detail(id),
    queryFn: () => getContract(id),
    enabled: Boolean(id),
  });
}

export function useReviewChange() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      contractId: string;
      changeId: string;
      state: ReviewState;
      reviewer: string;
      comment: string;
    }) =>
      reviewChange(
        input.contractId,
        input.changeId,
        input.state,
        input.reviewer,
        input.comment,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contractKeys.all }),
  });
}

export function useBulkReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      selections: Array<{ contractId: string; changeId: string }>;
      state: ReviewState;
      reviewer: string;
      comment: string;
    }) =>
      bulkReviewChanges(
        input.selections,
        input.state,
        input.reviewer,
        input.comment,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contractKeys.all }),
  });
}

export function useApplyDefinition() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { contractId: string; source: string }) =>
      applyContractDefinition(input.contractId, input.source),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contractKeys.all }),
  });
}

export function useImportContract() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (source: string) => importContractDocument(source),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contractKeys.all }),
  });
}

export function useUpdateStatements() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      contractId: string;
      changeId: string;
      patch: Partial<Pick<ContractChange, 'impactStatement' | 'migrationPlan'>>;
    }) => updateChangeStatements(input.contractId, input.changeId, input.patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contractKeys.all }),
  });
}

export function useConfirmDiff() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (contractId: string) => confirmDiffSnapshot(contractId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contractKeys.all }),
  });
}

export function useAddExemption() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { contractId: string; changeId: string; reason: string }) =>
      addExemption(input.contractId, input.changeId, input.reason),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contractKeys.all }),
  });
}

export function useFreezeVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { contractId: string; version: string; notes: string }) =>
      freezeVersion(input.contractId, input.version, input.notes),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contractKeys.all }),
  });
}
