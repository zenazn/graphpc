/**
 * Path types and utilities.
 *
 * A path is a list of segments representing navigation from the root
 * to a node in the object graph. Each segment is either a property name
 * (string) or a method call ([name, ...args]).
 */

export type PathSegment = string | [name: string, ...args: unknown[]];
export type PathSegments = PathSegment[];
