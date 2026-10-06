import { Badge } from '../ui/badge';
import {
  COMPATIBILITY_LABELS,
  REVIEW_STATE_LABELS,
  type Compatibility,
  type ReviewState,
} from '../../models/contract';

const compatibilityTone: Record<Compatibility, 'green' | 'amber' | 'red'> = {
  compatible: 'green',
  warning: 'amber',
  breaking: 'red',
};

const reviewTone: Record<ReviewState, 'neutral' | 'green' | 'red' | 'blue'> = {
  pending: 'neutral',
  accepted: 'green',
  returned: 'red',
  exemption: 'blue',
};

export function CompatibilityBadge({ value }: { value: Compatibility }) {
  return <Badge tone={compatibilityTone[value]}>{COMPATIBILITY_LABELS[value]}</Badge>;
}

export function ReviewStateBadge({ value }: { value: ReviewState }) {
  return <Badge tone={reviewTone[value]}>{REVIEW_STATE_LABELS[value]}</Badge>;
}
