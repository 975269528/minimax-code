export type TuiTodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface TuiTodoItem {
  readonly content: string;
  readonly status: TuiTodoStatus;
}
