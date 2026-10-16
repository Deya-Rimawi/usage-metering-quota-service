export type PlanKind = 'account' | 'user';

/** A limit of `null` means "no limit" for that rule. */
export interface Plan {
  id: string;
  kind: PlanKind;
  name: string;
  monthlyAllowance: number | null;
  maxPerRequest: number | null;
  predefined: boolean;
  createdAt: string;
  updatedAt: string;
}
