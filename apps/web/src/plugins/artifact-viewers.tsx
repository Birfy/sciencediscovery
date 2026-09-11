// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { Component, type ReactNode } from "react";
import { createViewRegistry } from "@sciencediscovery/plugin-sdk/views";
import { jsonViewer, type JsonPreviewInput } from "@sciencediscovery/plugin-artifact-json/web";

/** Trusted bundled entries only; no user paths, eval or remote module loading. */
export function createArtifactViewers(disabled: readonly string[] = []) {
  return createViewRegistry<JsonPreviewInput, ReactNode>([jsonViewer], disabled);
}
const viewers = createArtifactViewers();
class ViewBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
function Contribution({ input }: { input: JsonPreviewInput }) {
  const view = viewers.resolve(input);
  return view ? view.render(input) : <pre className="artifact-source-preview">{input.source}</pre>;
}
export function ArtifactViewerSlot(input: JsonPreviewInput) {
  return <ViewBoundary key={input.source} fallback={<pre className="artifact-source-preview">{input.source}</pre>}>
    <Contribution input={input} />
  </ViewBoundary>;
}
