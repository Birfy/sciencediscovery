from sciencediscovery_adapter.seed import MAX_CHARS, seeded_prompt, transcript


def test_a_conversation_becomes_text_oldest_first_with_tool_calls_and_results():
    history = [
        {"role": "user", "content": "run it"},
        {"role": "assistant", "content": "", "tool_calls": [{"id": "c", "type": "function", "function": {"name": "run_shell", "arguments": "{\"command\":\"ls\"}"}}]},
        {"role": "tool", "tool_call_id": "c", "name": "run_shell", "content": "a.txt"},
        {"role": "assistant", "content": "done"},
    ]
    assert transcript(history).splitlines() == [
        "user: run it", "assistant called run_shell({\"command\":\"ls\"})", "tool result (run_shell): a.txt", "assistant: done"]


def test_a_long_result_is_clipped_and_system_messages_are_ignored():
    text = transcript([{"role": "system", "content": "hidden"}, {"role": "tool", "name": "t", "content": "x" * 5000}])
    assert "hidden" not in text and len(text) < 700


def test_the_oldest_part_is_dropped_when_the_conversation_is_too_long():
    history = [{"role": "user", "content": f"message {i} " + "y" * 1000} for i in range(200)]
    text = transcript(history)
    assert len(text) <= MAX_CHARS + 1100 and "message 199" in text and "message 0 " not in text and "(earlier turns omitted)" in text


def test_no_history_leaves_the_prompt_alone():
    assert seeded_prompt([], "hi") == "hi"
    assert seeded_prompt([{"role": "system", "content": "x"}], "hi") == "hi"
