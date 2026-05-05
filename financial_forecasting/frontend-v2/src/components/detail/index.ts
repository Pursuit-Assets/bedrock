/**
 * Shared primitives for entity detail pages. Import from this barrel
 * so all five detail pages (Account, Opportunity, Contact, Award,
 * Project) speak the same vocabulary and pick up improvements in
 * lockstep.
 */
export { BackLink } from "./BackLink";
export type { BackLinkProps } from "./BackLink";

export { SectionCard } from "./SectionCard";
export type { SectionCardProps } from "./SectionCard";

export { Stat } from "./Stat";
export type { StatProps } from "./Stat";

export { DetailRow } from "./DetailRow";
export type { DetailRowProps } from "./DetailRow";

export { EditField } from "./EditField";
export type { EditFieldProps } from "./EditField";

export { Empty } from "./Empty";
export type { EmptyProps } from "./Empty";

export { useReferrer, useCurrentReferrer, withReferrer } from "./referrer";
export type { DetailReferrer, DetailReferrerState } from "./referrer";
