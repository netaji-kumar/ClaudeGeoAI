export interface User {
  name: string;
  email: string;
  isAdmin: boolean;
}

export interface Location {
  [key: string]: any;
  id: string | number;
  coordinates?: [number, number];
}

export interface Message {
  text: string;
  isUser: boolean;
  isSummary?: boolean;
  isLocation?: boolean;
}

export interface Group {
  id: string;
  name: string;
  members: string[];
}