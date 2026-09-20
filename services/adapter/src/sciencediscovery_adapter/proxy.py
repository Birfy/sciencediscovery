# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Streaming reverse proxy to the legacy API.

Everything the adapter has not taken over is forwarded byte for byte, including
Server-Sent Events, so the web UI sees one origin whether a route is migrated or
not.
"""

from __future__ import annotations

import httpx
from fastapi import Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from starlette.background import BackgroundTask

# RFC 9110 hop-by-hop fields are meaningful for one connection only.
_HOP_BY_HOP = frozenset({
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade",
})


def forwardable(headers, *, drop: frozenset[str] = frozenset()) -> list[tuple[str, str]]:
    """Header pairs safe to forward, in order and with repeats preserved.

    `headers.raw` is common to Starlette and httpx and keeps repeated fields.
    """
    pairs = [(name.decode("latin-1"), value.decode("latin-1")) for name, value in headers.raw]
    named_by_connection = {
        token.strip().lower()
        for name, value in pairs if name.lower() == "connection"
        for token in value.split(",")
    }
    skipped = _HOP_BY_HOP | drop | named_by_connection
    return [(name, value) for name, value in pairs if name.lower() not in skipped]


async def proxy_to_legacy(client: httpx.AsyncClient, request: Request) -> Response:
    """Forward `request` to the legacy API and stream the answer back."""
    has_body = request.method not in ("GET", "HEAD")
    upstream_request = client.build_request(
        request.method,
        httpx.URL(path=request.url.path, query=request.url.query.encode()),
        headers=forwardable(request.headers, drop=frozenset({"host", "content-length"})),
        content=request.stream() if has_body else None,
    )
    try:
        upstream = await client.send(upstream_request, stream=True)
    except httpx.HTTPError as error:
        return JSONResponse(
            {"error": "legacy_unavailable", "message": type(error).__name__},
            status_code=502,
        )
    response = StreamingResponse(
        upstream.aiter_raw(),
        status_code=upstream.status_code,
        background=BackgroundTask(upstream.aclose),
    )
    # Verbatim copy: repeated Set-Cookie fields, content-type and content-encoding
    # (the body is streamed undecoded) all survive.
    response.raw_headers = [
        (name.lower().encode("latin-1"), value.encode("latin-1"))
        for name, value in forwardable(upstream.headers)
    ]
    return response
