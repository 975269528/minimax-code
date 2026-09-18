export enum SigninDayStatus {
  Upcoming = 1,
  Claimable = 2,
  Claimed = 3,
  Disabled = 4,
}

export enum SigninClaimResult {
  Claimed = 1,
  AlreadyClaimed = 2,
}

export enum SigninPanelScene {
  Unknown = 0,
  First = 1,
  Active = 2,
  Completed = 3,
  Broken = 4,
}

export interface SigninDayItem {
  day_no: number;
  points: number;
  /** Extra credits already included in points; absent on older responses. */
  bonus_points?: number;
  status: SigninDayStatus;
  is_today: boolean;
}

export interface SigninPanel {
  scene: SigninPanelScene;
  days: SigninDayItem[];
}

export interface ClaimSigninData {
  claim_id: string;
  claim_result: SigninClaimResult;
  day_no: number;
  points: number;
  expire_at_ms: number;
  panel: SigninPanel;
}

const DAY_STATUSES = new Set<number>([
  SigninDayStatus.Upcoming,
  SigninDayStatus.Claimable,
  SigninDayStatus.Claimed,
  SigninDayStatus.Disabled,
]);
const CLAIM_RESULTS = new Set<number>([
  SigninClaimResult.Claimed,
  SigninClaimResult.AlreadyClaimed,
]);
const PANEL_SCENES = new Set<number>([
  SigninPanelScene.Unknown,
  SigninPanelScene.First,
  SigninPanelScene.Active,
  SigninPanelScene.Completed,
  SigninPanelScene.Broken,
]);

export function isSigninPanelClaimable(panel: SigninPanel | null): boolean {
  return Boolean(panel?.days.some((day) => day.status === SigninDayStatus.Claimable));
}

export function isSigninPanelClaimedToday(panel: SigninPanel | null): boolean {
  return Boolean(panel?.days.some((day) => day.is_today && day.status === SigninDayStatus.Claimed));
}

export function getCurrentSigninStreak(days: readonly SigninDayItem[]): number {
  const sortedDays = [...days].sort((left, right) => left.day_no - right.day_no);
  const todayIndex = sortedDays.findIndex((day) => day.is_today);
  if (todayIndex < 0) return 0;

  const todayStatus = sortedDays[todayIndex]?.status;
  let index =
    todayStatus === SigninDayStatus.Claimed
      ? todayIndex
      : todayStatus === SigninDayStatus.Claimable
        ? todayIndex - 1
        : -1;
  if (index < 0) return 0;

  let streak = 0;
  for (; index >= 0; index -= 1) {
    if (sortedDays[index]?.status !== SigninDayStatus.Claimed) break;
    streak += 1;
  }
  return streak;
}

export function validateSigninPanel(value: unknown): SigninPanel {
  const panel = value as Partial<SigninPanel> | null;
  const days = panel?.days;
  const dayNumbers = new Set<number>();
  let claimableDays = 0;
  let todayDays = 0;

  const validDays =
    Array.isArray(days) &&
    days.length === 7 &&
    days.every((day) => {
      if (!day || typeof day !== 'object') return false;
      const item = day as Partial<SigninDayItem>;
      const dayNo = item.day_no;
      if (
        typeof dayNo !== 'number' ||
        !Number.isInteger(dayNo) ||
        dayNo < 1 ||
        dayNo > 7 ||
        dayNumbers.has(dayNo)
      ) {
        return false;
      }
      if (
        typeof item.points !== 'number' ||
        !Number.isFinite(item.points) ||
        item.points < 0 ||
        (item.bonus_points !== undefined &&
          (typeof item.bonus_points !== 'number' ||
            !Number.isFinite(item.bonus_points) ||
            item.bonus_points < 0)) ||
        typeof item.is_today !== 'boolean' ||
        !DAY_STATUSES.has(item.status as number)
      ) {
        return false;
      }
      dayNumbers.add(dayNo);
      if (item.status === SigninDayStatus.Claimable) claimableDays += 1;
      if (item.is_today) todayDays += 1;
      return true;
    });

  if (
    panel === null ||
    typeof panel !== 'object' ||
    !PANEL_SCENES.has(panel.scene as number) ||
    !validDays ||
    claimableDays > 1 ||
    todayDays > 1
  ) {
    throw new Error('Invalid sign-in panel');
  }
  return panel as SigninPanel;
}

export function validateClaimSigninData(value: unknown): ClaimSigninData {
  const data = value as Partial<ClaimSigninData> | null;
  const valid =
    data !== null &&
    typeof data === 'object' &&
    typeof data.claim_id === 'string' &&
    data.claim_id.length > 0 &&
    CLAIM_RESULTS.has(data.claim_result as number) &&
    Number.isInteger(data.day_no) &&
    (data.day_no ?? 0) >= 1 &&
    (data.day_no ?? 8) <= 7 &&
    typeof data.points === 'number' &&
    Number.isFinite(data.points) &&
    data.points >= 0 &&
    typeof data.expire_at_ms === 'number' &&
    Number.isFinite(data.expire_at_ms);

  if (!valid) {
    throw new Error('Invalid sign-in claim response');
  }

  return {
    ...(data as ClaimSigninData),
    panel: validateSigninPanel(data.panel),
  };
}
