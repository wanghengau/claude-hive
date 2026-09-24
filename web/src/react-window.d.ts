declare module 'react-window' {
  import type { ComponentType, CSSProperties } from 'react';

  export interface ListChildComponentProps<T = any> {
    index: number;
    style: CSSProperties;
    data: T;
  }

  export interface FixedSizeListProps {
    height: number;
    width: number | string;
    itemCount: number;
    itemSize: number;
    children: ComponentType<ListChildComponentProps>;
    className?: string;
    [key: string]: unknown;
  }

  export class FixedSizeList extends React.Component<FixedSizeListProps> {
    static displayName?: string;
  }

  export interface VariableSizeListProps {
    height: number;
    width: number | string;
    itemCount: number;
    itemSize: (index: number) => number;
    estimatedItemSize?: number;
    children: ComponentType<ListChildComponentProps>;
    className?: string;
    [key: string]: unknown;
  }

  export class VariableSizeList extends React.Component<VariableSizeListProps> {
    static displayName?: string;
    // 使 itemSize 缓存失效并重算：哨兵（镜像行）移位后高度分布变化时调用
    resetAfterIndex(index: number, shouldForceUpdate?: boolean): void;
  }

  import React from 'react';
}
