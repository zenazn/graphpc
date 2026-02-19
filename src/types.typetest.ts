/**
 * Type-level tests for RpcStub<T>.
 *
 * This file is NOT executed at runtime. It is checked by `bun typecheck` (tsc --noEmit).
 * Every @ts-expect-error must suppress a real error — tsc reports unused
 * @ts-expect-error directives as errors, so each one doubles as a negative assertion.
 */

import type { Reference } from "./ref.ts";
import { ref } from "./ref.ts";
import type { Path } from "./node-path.ts";
import type { PathArg } from "./path-arg.ts";
import type { RpcStub, RpcDataOf } from "./types.ts";
import { Node, canonicalPath } from "./types.ts";

// ---------------------------------------------------------------------------
// Test graph (type-only — no runtime code)
// ---------------------------------------------------------------------------

declare class Post extends Node {
  id: string;
  title: string;
  body: string;
  updateTitle(title: string): Promise<void>;
}

declare class PostsService extends Node {
  get(id: string): Post;
  list(): Promise<Reference<Post>[]>;
  count(): Promise<number>;
}

declare class User extends Node {
  name: string;
  email: string;
}

declare class UsersService extends Node {
  get(id: string): User;
}

/** Root with edges, a method, and a primitive property */
declare class Api extends Node {
  posts: PostsService;
  users: UsersService;
  version: string;
  ping(): Promise<string>;
}

/** Leaf node with only primitive data — no edges, no methods */
declare class LeafNode extends Node {
  value: number;
  label: string;
}

/** Async edge test: service with a method returning Promise<Node> */
declare class AsyncPostsService extends Node {
  load(id: string): Promise<Post>;
}

/** ShallowContainsNode: safe service returning Reference<Post>[] */
declare class SafeService extends Node {
  listPosts(): Promise<Reference<Post>[]>;
}

/** ShallowContainsNode: unsafe — bare Node[] */
declare class UnsafeService extends Node {
  listPosts(): Promise<Post[]>;
}

/** ShallowContainsNode: unsafe — bare Node in object property */
declare class UnsafeObjService extends Node {
  getContainer(): Promise<{ post: Post }>;
}

/** Nullable method return */
declare class NullableService extends Node {
  find(id: string): Promise<string | null>;
}

/** Method returning void */
declare class VoidMethodService extends Node {
  cleanup(): Promise<void>;
}

/** ShallowContainsNode: Map with bare Node values */
declare class UnsafeMapService extends Node {
  getMap(): Promise<Map<string, Post>>;
}

/** ShallowContainsNode: Set with bare Node values */
declare class UnsafeSetService extends Node {
  getSet(): Promise<Set<Post>>;
}

/** Sync method returns (non-Promise, non-Node) */
declare class SyncMethodService extends Node {
  getValue(): string;
  add(a: number, b: number): number;
  doWork(): void;
}

declare const api: RpcStub<Api>;
declare const syncSvc: RpcStub<SyncMethodService>;
declare const leaf: RpcStub<LeafNode>;
declare const asyncSvc: RpcStub<AsyncPostsService>;
declare const safeSvc: RpcStub<SafeService>;
declare const unsafeSvc: RpcStub<UnsafeService>;
declare const unsafeObjSvc: RpcStub<UnsafeObjService>;
declare const nullableSvc: RpcStub<NullableService>;
declare const voidSvc: RpcStub<VoidMethodService>;
declare const unsafeMapSvc: RpcStub<UnsafeMapService>;
declare const unsafeSetSvc: RpcStub<UnsafeSetService>;

// ===========================================================================
// POSITIVE — these must compile
// ===========================================================================

// -- Edge navigation: Node-typed properties become RpcStub --
{
  const _posts: RpcStub<PostsService> = api.posts;
  const _users: RpcStub<UsersService> = api.users;
}

// -- Edge method: function returning Node → returns RpcStub --
{
  const _post: RpcStub<Post> = api.posts.get("1");
  const _user: RpcStub<User> = api.users.get("alice");
}

// -- @method: function returning Promise<T> where T is not Node → stays Promise<T> --
{
  const _count: Promise<number> = api.posts.count();
  const _ping: Promise<string> = api.ping();
}

// -- Async edge: function returning Promise<Node> → RpcStub (not Promise) --
{
  const _post: RpcStub<Post> = asyncSvc.load("1");
}

// -- Deep chaining without intermediate await --
{
  const _update: Promise<void> = api.posts.get("1").updateTitle("new");
}

// -- PromiseLike: stubs expose .then --
{
  api.posts.get("1").then((data) => {
    const _title: string = data.title;
    const _id: string = data.id;
    const _update: Promise<void> = data.updateTitle("x");
  });
}

// -- Awaited stub yields data properties + navigable methods --
async function _positiveAwait() {
  const post = await api.posts.get("1");
  const _title: string = post.title;
  const _id: string = post.id;
  const _body: string = post.body;
  const _update: Promise<void> = post.updateTitle("new");
}

// -- Awaited root yields primitive data + navigation --
async function _positiveAwaitRoot() {
  const root = await api;
  const _version: string = root.version;
  const _posts: RpcStub<PostsService> = root.posts;
  const _ping: Promise<string> = root.ping();
}

// -- Reference unwrapping: Promise<Reference<T>[]> → transparent data+stub hybrid --
async function _positiveRefUnwrap() {
  const posts = await api.posts.list();
  const first = posts[0]!;
  const _title: string = first.title;
  const _id: string = first.id;
  const _body: string = first.body;
  const _update: Promise<void> = first.updateTitle("new");
}

// -- Leaf node: must await to access primitives --
async function _positiveLeaf() {
  const data = await leaf;
  const _value: number = data.value;
  const _label: string = data.label;
}

// -- Node-typed properties excluded from RpcDataOf --
{
  type ApiData = RpcDataOf<Api>;
  // Should only contain version (string), not posts/users (Node types)
  const _version: ApiData["version"] = "" as string;
}

// -- Nullable return: Promise<string | null> stays as-is --
{
  const _result: Promise<string | null> = nullableSvc.find("1");
}

// -- Void return: Promise<void> stays as-is --
{
  const _result: Promise<void> = voidSvc.cleanup();
}

// -- Sync methods: non-Promise returns become Promise on the stub --
{
  const _val: Promise<string> = syncSvc.getValue();
  const _sum: Promise<number> = syncSvc.add(1, 2);
  const _void: Promise<void> = syncSvc.doWork();
}

// -- ShallowContainsNode: Reference<Post>[] passes (no error) --
{
  const _posts: Promise<
    (RpcDataOf<Post> & { updateTitle(title: string): Promise<void> })[]
  > = safeSvc.listPosts();
}

// ===========================================================================
// NEGATIVE — every @ts-expect-error must suppress a real error
// ===========================================================================

// -- Wrong argument type --
// @ts-expect-error get() requires string, not number
api.posts.get(123);

// -- Too few arguments --
// @ts-expect-error get() requires 1 argument
api.posts.get();

// -- Too many arguments --
// @ts-expect-error get() accepts exactly 1 argument
api.posts.get("1", "extra");

// -- Primitive properties are not navigable on stubs (must await) --
// @ts-expect-error version is a string primitive, not in RpcNav
api.version;

// -- Leaf node primitives are not navigable --
// @ts-expect-error value is a number, not navigable on the stub
leaf.value;

// @ts-expect-error label is a string, not navigable on the stub
leaf.label;

// -- Data properties are readonly after await --
async function _negativeReadonly() {
  const post = await api.posts.get("1");
  // @ts-expect-error title is readonly
  post.title = "changed";
  // @ts-expect-error id is readonly
  post.id = "new-id";
}

// -- Non-existent properties produce errors after await --
async function _negativeNonExistent() {
  const post = await api.posts.get("1");
  // @ts-expect-error nonExistent is not a member of Post
  post.nonExistent;
}

// -- Non-existent properties on references produce errors --
async function _negativeRefNoSuchProp() {
  const posts = await api.posts.list();
  const first = posts[0]!;
  // @ts-expect-error nonExistent is not a member of Post
  first.nonExistent;
}

// -- Reference data is readonly --
async function _negativeRefReadonly() {
  const posts = await api.posts.list();
  const first = posts[0]!;
  // @ts-expect-error reference data properties are readonly
  first.title = "x";
}

// -- Edge method return is RpcStub, not the raw class --
{
  // @ts-expect-error get() returns RpcStub<Post>, not Post
  const _wrong: Post = api.posts.get("1");
}

// -- @method return is Promise, not RpcStub --
{
  // @ts-expect-error count() returns Promise<number>, not number
  const _wrong: number = api.posts.count();
}

// -- ShallowContainsNode: Post[] triggers error type --
{
  // @ts-expect-error returns ShallowNodeError (bare Node in array)
  const _posts: Promise<Post[]> = unsafeSvc.listPosts();
}

// -- ShallowContainsNode: { post: Post } triggers error type --
{
  // @ts-expect-error returns ShallowNodeError (bare Node in object property)
  const _result: Promise<{ post: Post }> = unsafeObjSvc.getContainer();
}

// -- ShallowContainsNode: Map<string, Post> triggers error type --
{
  // @ts-expect-error returns ShallowNodeError (bare Node in Map)
  const _map: Promise<Map<string, Post>> = unsafeMapSvc.getMap();
}

// -- ShallowContainsNode: Set<Post> triggers error type --
{
  // @ts-expect-error returns ShallowNodeError (bare Node in Set)
  const _set: Promise<Set<Post>> = unsafeSetSvc.getSet();
}

// -- Sync method return is Promise, not the raw type --
{
  // @ts-expect-error getValue() returns Promise<string>, not string
  const _wrong: string = syncSvc.getValue();
}

// -- Node-typed properties are NOT in RpcDataOf (they are edges) --
{
  type ApiData = RpcDataOf<Api>;
  // @ts-expect-error posts is a Node, excluded from RpcDataOf
  const _check: ApiData["posts"] = {} as PostsService;
}

// ===========================================================================
// ref() — compile-time [canonicalPath] requirement
// ===========================================================================

// -- Test classes for ref() --

declare class Tweet extends Node {
  id: string;
  text: string;
}
declare const TweetCtor: typeof Tweet & {
  [canonicalPath]: (root: any, id: string) => any;
};

declare class OrphanNode extends Node {
  name: string;
}

// -- POSITIVE: ref() accepts class with [canonicalPath] + correct args --
{
  const _tweet: Promise<Reference<Tweet>> = ref(TweetCtor, "42");
}

// -- NEGATIVE: ref() rejects class without [canonicalPath] --
{
  // @ts-expect-error OrphanNode has no [canonicalPath]
  ref(OrphanNode);
}

// -- NEGATIVE: ref() rejects wrong arg type --
{
  // @ts-expect-error canonicalPath expects string, not number
  ref(TweetCtor, 123);
}

// -- NEGATIVE: ref() rejects missing required arg --
{
  // @ts-expect-error canonicalPath expects 1 arg
  ref(TweetCtor);
}

// -- NEGATIVE: ref() rejects extra args --
{
  // @ts-expect-error canonicalPath expects exactly 1 arg
  ref(TweetCtor, "42", "extra");
}

// ===========================================================================
// Path<T> — client-side type mapping
// ===========================================================================

// -- Test classes for Path --

declare class Category extends Node {
  name: string;
}

declare class MoveService extends Node {
  move(post: Path<Post>, cat: Path<Category>): Promise<void>;
}

declare class ListPathService extends Node {
  list(): Promise<Path<Post>[]>;
}

declare const moveSvc: RpcStub<MoveService>;
declare const listPathSvc: RpcStub<ListPathService>;

// -- POSITIVE: Path<T> in method params → PathArg on client --
{
  moveSvc.move(null! as PathArg, null! as PathArg);
}

// -- POSITIVE: Path<T> in method return → RpcStub<T>[] on client --
async function _pathReturn() {
  const posts: RpcStub<Post>[] = await listPathSvc.list();
  void posts;
}

// -- NEGATIVE: string not assignable to PathArg --
{
  // @ts-expect-error — string not assignable to PathArg
  moveSvc.move("nope", "also nope");
}

// -- NEGATIVE: wrong number of PathArg args --
{
  // @ts-expect-error — needs 2 args
  moveSvc.move(null! as PathArg);
}
