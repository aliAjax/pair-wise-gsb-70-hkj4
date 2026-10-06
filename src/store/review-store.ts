import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ReviewState } from '../models/contract';

interface ReviewSelection {
  contractId: string;
  changeId: string;
}

interface ReviewStore {
  selectedContractId: string;
  activeTab: string;
  reviewStateFilter: ReviewState | 'all';
  selection: ReviewSelection[];
  setSelectedContract: (contractId: string) => void;
  setActiveTab: (tab: string) => void;
  setReviewStateFilter: (filter: ReviewState | 'all') => void;
  toggleSelection: (selection: ReviewSelection) => void;
  clearSelection: () => void;
  selectMany: (selections: ReviewSelection[]) => void;
}

export const useReviewStore = create<ReviewStore>()(
  persist(
    (set) => ({
      selectedContractId: '',
      activeTab: 'overview',
      reviewStateFilter: 'all',
      selection: [],
      setSelectedContract: (selectedContractId) => set({ selectedContractId }),
      setActiveTab: (activeTab) => set({ activeTab }),
      setReviewStateFilter: (reviewStateFilter) => set({ reviewStateFilter }),
      toggleSelection: (candidate) =>
        set((state) => {
          const exists = state.selection.some(
            (item) =>
              item.contractId === candidate.contractId && item.changeId === candidate.changeId,
          );
          return {
            selection: exists
              ? state.selection.filter(
                  (item) =>
                    item.contractId !== candidate.contractId ||
                    item.changeId !== candidate.changeId,
                )
              : [...state.selection, candidate],
          };
        }),
      clearSelection: () => set({ selection: [] }),
      selectMany: (selection) => set({ selection }),
    }),
    {
      name: 'pair-wise-gsb-70-review-ui',
      partialize: (state) => ({
        selectedContractId: state.selectedContractId,
        activeTab: state.activeTab,
        reviewStateFilter: state.reviewStateFilter,
        selection: state.selection,
      }),
    },
  ),
);
