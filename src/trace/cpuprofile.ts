import { hierarchy, HierarchyNode } from 'd3-hierarchy';
import {
  FUNCTION_NAME,
  ICpuProfile,
  ICpuProfileNode,
  IProfileNode,
  ISample,
  ITraceEvent,
  TRACE_EVENT_NAME,
  TRACE_EVENT_PHASE,
} from './trace_event';

export default class CpuProfile {
  profile: ICpuProfile;

  /**
   * Node by node id.
   */
  nodeMap: Map<number, ICpuProfileNode>;

  samples: ISample[];

  /**
   * Root parent
   */
  root?: ICpuProfileNode;

  start: number;
  end: number;
  duration: number;

  hierarchy: HierarchyNode<ICpuProfileNode>;

  private parentLinks: Map<ICpuProfileNode, ICpuProfileNode>;
  private childrenLinks: Map<ICpuProfileNode, ICpuProfileNode[]>;

  constructor(profile: ICpuProfile, events: ITraceEvent[], min: number, max: number) {
    this.profile = profile;

    const parentLinks = (this.parentLinks = new Map<ICpuProfileNode, ICpuProfileNode>());
    const childrenLinks = (this.childrenLinks = new Map<ICpuProfileNode, ICpuProfileNode[]>());

    const nodes = profile.nodes;
    initNodes(nodes);
    const nodeMap = mapAndLinkNodes(nodes, parentLinks, childrenLinks);

    const originalRoot: ICpuProfileNode | undefined = nodes.find(node => {
      return node.callFrame.scriptId === 0 || node.callFrame.scriptId === '0' &&
             node.callFrame.functionName === FUNCTION_NAME.ROOT;
    });
    if (originalRoot === undefined) throw new Error('Missing root node in original profile');

    this.samples = absoluteSamples(profile, nodeMap);
    const {expandedRoot, expandedNodeMap} = expandAndFix(this.samples, profile, events,
                                               min, max, parentLinks, childrenLinks, originalRoot);
    this.root = expandedRoot;
    this.nodeMap = expandedNodeMap;

    const start = (this.start = profile.startTime);
    const end = (this.end = expandedRoot.max);
    this.duration = end - start;

    this.hierarchy = hierarchy(expandedRoot, node => {
      const children = childrenLinks.get(node);
      if (children) {
        return expandedRoot === node ? children.filter(n => !isMetaNode(n)) : children;
      }
      return null;
    });

    // Make child iteration easier
    this.hierarchy.each(node => { if (node.children === undefined) node.children = []; });

    addRenderNodes(this.hierarchy, events);
  }

  parent(node: ICpuProfileNode) {
    return this.parentLinks.get(node);
  }

  children(node: ICpuProfileNode) {
    return this.childrenLinks.get(node);
  }

  node(id: number) {
    const n = this.nodeMap.get(id);
    if (n === undefined) throw new Error(`invalid node id: ${id}`);
    return n;
  }
}

function addRenderNodes(hierarchy: HierarchyNode<ICpuProfileNode>, events: ITraceEvent[]) {
  const render2node = {};

  events.forEach(event => {
    if (isRenderPhase(event)) {
      // console.log(`\nevent:${event.name}`);
      // const renderParent = trace.getParent(event);
      let found: HierarchyNode<ICpuProfileNode> | null = null;
      let min = null;
      hierarchy.eachBefore((node: HierarchyNode<ICpuProfileNode>) => {
        if (node.data.self !== 0) {
          if (node.data.min !== -1 && node.data.max !== -1 &&
              node.data.min < event.ts && event.ts + event.dur! < node.data.max) {
            // tslint:disable-next-line:max-line-length
            console.log(`node:${node.data.callFrame.functionName} min:${node.data.min - event.ts} max:${node.data.max - event.ts + event.dur!}`);
            console.log(`dur:${node.data.max - node.data.min}`);
            found = node;
          }
        }
      });

      if (found) {
        this.insertRenderEvent(found, event);
      }
    }
  });
}

function insertRenderEvent(node: HierarchyNode<ICpuProfileNode>, event: ITraceEvent) {
  const eventStart = event.ts;
  const eventEnd = event.ts + event.dur!;

  // create render node and set its length
  const renderNode = node.copy();
  renderNode.data = JSON.parse(JSON.stringify(node.data));
  renderNode.data.min = eventStart;
  renderNode.data.max = eventEnd;
  renderNode.data.self = 0;
  renderNode.data.callFrame.functionName = event.name;

  // children who are to the left or right of the render event
  const childrenForOriginal = node.children!.filter(child => child.data.max < eventStart ||
                                                             child.data.min > eventEnd);
  // children who are within the render event
  const childrenForRenderNode = node.children!.filter(child => child.data.min > eventStart &&
                                                               child.data.max < eventEnd);
  // children who are split by the render event
  const leftSplitChild = node.children!.find(n => n.data.min < eventStart && n.data.max > eventStart);
  const rightSplitChild = node.children!.find(n => n.data.min < eventEnd && n.data.max > eventEnd);

  // fix parent/child links for all children other then split children
  node.children = childrenForOriginal;
  renderNode.children = childrenForRenderNode;
  childrenForRenderNode.forEach(child => child.parent = renderNode);

  // fix node/render node parent/child link
  renderNode.parent = node;
  node.children!.push(renderNode);

  splitChild(node, renderNode, leftSplitChild, eventStart);
  splitChild(renderNode, node, rightSplitChild, eventEnd);
}

function fixLeftsChildren(node: HierarchyNode<ICpuProfileNode>) {
  if (node.children === undefined) return 0;

  // remove any children which end after node
  node.children = node.children.filter(child => child.data.max < node.data.max);
  // return total time of children
  return node.children.reduce((a, b) => a + b.data.total, 0);
}

function fixRightsChildren(node: HierarchyNode<ICpuProfileNode>) {
  if (node.children === undefined) return 0;

  // remove any children which start before node
  node.children = node.children.filter(child => child.data.min > node.data.min);
  // return total time of children
  return node.children.reduce((a, b) => a + b.data.total, 0);
}

// responsible for splitting the node, linking up the halves with the passed in parents.
function splitChild(leftParent: HierarchyNode<ICpuProfileNode>,
                    rightParent: HierarchyNode<ICpuProfileNode>,
                    node: HierarchyNode<ICpuProfileNode> | undefined, splitTS: number) {
  if (node === undefined) {
    return {middleLeftTime: 0, middleRightTime: 0};
  }
  // Split node
  const left = node;
  const right = node.copy();
  right.data = JSON.parse(JSON.stringify(node.data));

  left.data.max = splitTS;
  right.data.min = splitTS;

  // Add back in the child/parent links for the split node
  left.parent = leftParent;
  leftParent.children!.push(left);
  right.parent = rightParent;
  rightParent.children!.push(right);

  // if no further children, you are done
  if (node.children === undefined) {
    left.data.self = left.data.total = left.data.max - left.data.min;
    right.data.self = right.data.total = right.data.max - right.data.min;
    return {middleLeftTime: left.data.total, middleRightTime: right.data.total};
  }

  // remove right children and middle child from left node & visa versa for right node.
  const middleChild = node.children.find(n => n.data.min < splitTS && n.data.max > splitTS);
  let leftTime = fixLeftsChildren(left);
  let rightTime = fixRightsChildren(right);

  const { middleLeftTime, middleRightTime } = splitChild(left, right, middleChild, splitTS);
  leftTime += middleLeftTime;
  rightTime += middleRightTime;

  // return total time of the left and right side of split, so parents can determine their own self times
  return {middleLeftTime: leftTime, middleRightTime: rightTime};
}

function expandAndFix(
  samples: ISample[],
  profile: ICpuProfile,
  events: ITraceEvent[],
  min: number,
  max: number,
  parentLinks: Map<ICpuProfileNode, ICpuProfileNode>,
  childrenLinks: Map<ICpuProfileNode, ICpuProfileNode[]>,
  root: ICpuProfileNode,
) {
  const {expandedNodes, orig2ExpNodes} = expandNodes(samples, events, min, max, parentLinks);
  profile.nodes = expandedNodes;
  parentLinks.clear();
  childrenLinks.clear();

  const expandedNodeMap = mapAndLinkNodes(expandedNodes, parentLinks, childrenLinks);

  if (! orig2ExpNodes.has(root.id)) throw new Error('Missing root node in expanded profile');
  return {expandedRoot: orig2ExpNodes.get(root.id)![0], expandedNodeMap};
}

function initNodes(
  nodes: ICpuProfileNode[],
) {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    // initialize our extensions
    node.min = -1;
    node.max = -1;
    node.sampleCount = 0;
    node.self = 0;
  }
}

function mapAndLinkNodes(
  nodes: ICpuProfileNode[],
  parentLinks: Map<ICpuProfileNode, ICpuProfileNode>,
  childrenLinks: Map<ICpuProfileNode, ICpuProfileNode[]>,
) {
  const nodeMap = new Map<number, ICpuProfileNode>();
  for (let i = 0; i < nodes.length; i++) {
    nodeMap.set(nodes[i].id, nodes[i]);
  }

  linkNodes(nodes, nodeMap, parentLinks, childrenLinks);
  return nodeMap;
}

function linkNodes(
  nodes: ICpuProfileNode[],
  nodeMap: Map<number, ICpuProfileNode>,
  parentLinks: Map<ICpuProfileNode, ICpuProfileNode>,
  childrenLinks: Map<ICpuProfileNode, ICpuProfileNode[]>,
) {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    linkChildren(node, nodeMap, parentLinks, childrenLinks);
  }
}

function linkChildren(
  parent: ICpuProfileNode,
  nodeMap: Map<number, ICpuProfileNode>,
  parentLinks: Map<ICpuProfileNode, ICpuProfileNode>,
  childrenLinks: Map<ICpuProfileNode, ICpuProfileNode[]>,
) {
  const childIds = parent.children;
  if (childIds === undefined) return;

  const children: ICpuProfileNode[] = new Array(childIds.length);
  for (let i = 0; i < childIds.length; i++) {
    const child = nodeMap.get(childIds[i])!;
    children[i] = child;
    parentLinks.set(child, parent);
  }
  childrenLinks.set(parent, children);
}

function absoluteSamples(
  profile: ICpuProfile,
  nodeMap: Map<number, ICpuProfileNode>,
) {
  const sampleIds = profile.samples;
  const samples: ISample[] = new Array(sampleIds.length);
  // deltas can be negative and samples out of order
  const timeDeltas = profile.timeDeltas;
  let last = profile.startTime;
  for (let i = 0; i < sampleIds.length; i++) {
    const node = nodeMap.get(sampleIds[i])!;
    const timestamp = last + timeDeltas[i];
    samples[i] = {
      node,
      delta: 0,
      timestamp,
      prev: null,
      next: null,
    };
    last = timestamp;

    node.sampleCount++;
  }

  samples.sort((a, b) => a.timestamp - b.timestamp);

  let prev: ISample | null = null;

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    const timestamp = sample.timestamp;

    if (prev === null) {
      sample.delta = timestamp - profile.startTime;
    } else {
      prev.next = sample;
      sample.delta = timestamp - prev.timestamp;
      sample.prev = prev;
    }
    prev = sample;
  }

  return samples;
}

function expandNodes(
  samples: ISample[],
  events: ITraceEvent[],
  min: number,
  max: number,
  parentLinks: Map<ICpuProfileNode, ICpuProfileNode>,
) {
  const expandedNodes: ICpuProfileNode[] = [];
  const orig2ExpNodes = new Map<number, ICpuProfileNode[]>();
  const state: ExpState = {
    isExecuting: false,
    lastSampleTS: -1,
    stack: [],
    origId2activeIndex: new Map<number, number>(),
    expId2origId: new Map<number, number>(),
  };

  let i = 0;
  let j = 0;

  for (; i < samples.length && j < events.length;) {
    if (samples[i].timestamp <= events[j].ts) {
      if (!isOutOfBounds(samples[i].timestamp, min, max) && state.isExecuting) {
        processSample(samples[i], orig2ExpNodes, parentLinks, expandedNodes, state);
      }
      i++;
    } else {
      if (!isOutOfBounds(events[j].ts, min, max)) {
        processEvent(events[j], state);
      }
      j++;
    }
  }

  for (; i < samples.length; i++) {
    if (!isOutOfBounds(samples[i].timestamp, min, max) && state.isExecuting) {
      processSample(samples[i], orig2ExpNodes, parentLinks, expandedNodes, state);
    }
  }

  for (; j < events.length; j++) {
    if (!isOutOfBounds(events[j].ts, min, max)) {
      processEvent(events[j], state);
    }
  }

  return {expandedNodes, orig2ExpNodes};
}

function isOutOfBounds(ts: number, min: number, max: number) {
  return ts < min || (max !== -1 && ts > max);
}

function terminateNodes(
  toTerminate: ICpuProfileNode[],
  ts: number,
  state: ExpState,
) {
  toTerminate.forEach(node => {
    state.origId2activeIndex.delete(state.expId2origId.get(node.id)!);
    state.expId2origId.delete(node.id);
    node.max = ts;
  });
}

function activateNodes(
  toActivate: ICpuProfileNode[],
  state: ExpState,
  ts: number,
  newNodes: ICpuProfileNode[],
  orig2ExpNodes: Map<number, ICpuProfileNode[]>,
) {
  const { stack, origId2activeIndex, expId2origId } = state;
  let parent = stack[stack.length - 1];

  for (let i = toActivate.length - 1; i >= 0; i--) {
    const oldNode = toActivate[i];
    // IProfileNode type gives access to the .parent attribute
    const newNode: ICpuProfileNode & IProfileNode = JSON.parse(JSON.stringify(oldNode));
    newNode.id = newNodes.length;

    if (parent) {
      newNode.parent = parent.id;

      const children = parent.children;
      if (children !== undefined) {
        children.push(newNode.id);
      } else {
        parent.children = [newNode.id];
      }
    }

    // clear out node-->children links
    newNode.children = undefined;

    newNode.min = ts;
    newNode.max = -1;
    newNode.self = 0;
    newNode.total = 0;

    newNodes.push(newNode);
    stack.push(newNode);
    origId2activeIndex.set(oldNode.id, stack.length - 1);
    expId2origId.set(newNode.id, oldNode.id);
    if (orig2ExpNodes.has(oldNode.id)) {
      orig2ExpNodes.get(oldNode.id)!.push(newNode);
    } else {
      orig2ExpNodes.set(oldNode.id, [newNode]);
    }

    parent = newNode;
  }
}

function addDurationToNodes(
  stack: ICpuProfileNode[],
  delta: number,
) {
  for (let i = 0; i < stack.length; i++) {
    stack[i].total += delta;
  }
  if (stack.length > 0) stack[stack.length - 1].self += delta;
}

interface ExpState {
  isExecuting: boolean;
  lastSampleTS: number;
  stack: ICpuProfileNode[];
  origId2activeIndex: Map<number, number>;
  expId2origId: Map<number, number>;
}

function processExecute(
  event: ITraceEvent,
  state: ExpState,
) {
  const { stack, lastSampleTS } = state;

  if (event.ph === TRACE_EVENT_PHASE.COMPLETE) {
    state.isExecuting = true;
  } else if (event.ph === TRACE_EVENT_PHASE.END) {
    addDurationToNodes(stack, event.ts - lastSampleTS);
    const toTerminate = stack.splice(1); // don't slice (root)
    terminateNodes(toTerminate, event.ts, state);
    state.isExecuting = false;
  }
}

/*function processRender(
  event: ITraceEvent,
  state: ExpState,
) {
  const { stack, lastSampleTS } = state;

  if (event.ph === TRACE_EVENT_PHASE.COMPLETE) {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].)
    }
  } else if (event.ph === TRACE_EVENT_PHASE.END) {

  }
}*/

function isRenderStart(event: ITraceEvent) {
  return event.ph === TRACE_EVENT_PHASE.NESTABLE_ASYNC_BEGIN && event.name.charAt(0) === '<';
}

function isRenderEnd(event: ITraceEvent) {
  return event.ph === TRACE_EVENT_PHASE.NESTABLE_ASYNC_END && event.name.charAt(0) === '<';
}

function isRenderPhase(event: ITraceEvent) {
  return event.ph === TRACE_EVENT_PHASE.COMPLETE && event.name.charAt(0) === '<';
}

function isRenderEvent(event: ITraceEvent) {
  return event.ph === TRACE_EVENT_PHASE.COMPLETE ||
         event.ph === TRACE_EVENT_PHASE.NESTABLE_ASYNC_END &&
         event.name.charAt(0) === '<';
}

function processEvent(
  event: ITraceEvent,
  state: ExpState,
) {
  if (event.name === TRACE_EVENT_NAME.V8_EXECUTE) {
    processExecute(event, state);
  } /*else if (isRenderEvent(event)) {
    processRender(event, state);
  }*/
}

function processSample(
  sample: ISample,
  orig2ExpNodes: Map<number, ICpuProfileNode[]>,
  parentLinks: Map<ICpuProfileNode, ICpuProfileNode>,
  newNodes: ICpuProfileNode[],
  state: ExpState,
) {
  const { stack, origId2activeIndex } = state;
  let curNode: ICpuProfileNode | undefined;
  const toActivate: ICpuProfileNode[] = [];

  state.lastSampleTS = sample.timestamp;

  for (curNode = sample.node; curNode; curNode = parentLinks.get(curNode)) {
    if (origId2activeIndex.has(curNode.id)) break;
    toActivate.push(curNode);
  }

  addDurationToNodes(stack, sample.delta);

  let spliceStart;
  if (curNode === undefined) {
    // No ongoing nodes, remove everything from the stack
    spliceStart = 0;
  } else {
    // Don't let GC or Program samples terminate the current stack
    if (sample.node.callFrame.functionName === FUNCTION_NAME.GC ||
        sample.node.callFrame.functionName === FUNCTION_NAME.PROGRAM) {
          spliceStart = stack.length; // no-op for slice
    } else {
      // Leave only ongoing nodes on the stack
      spliceStart = origId2activeIndex.get(curNode.id)! + 1;
    }
  }
  const toTerminate = stack.splice(spliceStart);

  terminateNodes(toTerminate, sample.timestamp, state);
  activateNodes(toActivate, state, sample.timestamp, newNodes, orig2ExpNodes);
}

export function isMetaNode(node: ICpuProfileNode) {
  switch (node.callFrame.functionName) {
    case FUNCTION_NAME.ROOT:
    case FUNCTION_NAME.IDLE:
      return true;
  }
  return false;
}
