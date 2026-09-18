import type { TuiTodoItem, TuiTodoStatus } from '../../todo/model.js';

const TODO_STATUSES = new Set<TuiTodoStatus>(['pending', 'in_progress', 'completed', 'cancelled']);

export class TuiTodoProjection {
  private items: readonly TuiTodoItem[] = [];
  private sourceTurnId: string | undefined;

  constructor(private readonly onChange: (items: readonly TuiTodoItem[]) => void) {}

  apply(turnId: string, data: Readonly<Record<string, unknown>>): boolean {
    if (!Array.isArray(data.todos)) return false;
    if (data.todos.length === 0) return this.clear();

    const todoItems = data.todos.flatMap(normalizeTodoItem);
    if (todoItems.length === 0) return false;
    if (sameTodos(this.items, todoItems)) return false;
    this.items = todoItems;
    this.sourceTurnId = turnId;
    this.onChange(this.items);
    return true;
  }

  clear(): boolean {
    if (this.items.length === 0) return false;
    this.items = [];
    this.sourceTurnId = undefined;
    this.onChange(this.items);
    return true;
  }

  clearSettled(): boolean {
    if (this.items.length === 0 || this.items.some((item) => !isSettled(item.status))) return false;
    return this.clear();
  }

  clearForTurn(turnId: string): boolean {
    return this.sourceTurnId === turnId ? this.clear() : false;
  }
}

function isSettled(status: TuiTodoStatus): boolean {
  return status === 'completed' || status === 'cancelled';
}

function normalizeTodoItem(value: unknown): TuiTodoItem[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const item = value as Readonly<Record<string, unknown>>;
  const content = typeof item.content === 'string' ? item.content.trim() : '';
  if (!content) return [];
  const status = typeof item.status === 'string' ? item.status : '';
  return [
    {
      content,
      status: TODO_STATUSES.has(status as TuiTodoStatus) ? (status as TuiTodoStatus) : 'pending',
    },
  ];
}

function sameTodos(left: readonly TuiTodoItem[], right: readonly TuiTodoItem[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (item, index) =>
        item.content === right[index]?.content && item.status === right[index]?.status,
    )
  );
}
