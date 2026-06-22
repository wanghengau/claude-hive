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

  import React from 'react';
}
