"""Characterization tests for extracted fix_json_formatting (Phase 2A).

Locks in exactly what the current implementation repairs (missing commas,
trailing commas, an extra closing brace before a final bracket, collapsing
``]}]``) and what it intentionally does NOT handle (single quotes, unquoted
keys, code fences, surrounding prose, otherwise-malformed JSON). These tests do
not expand the accepted format set.
"""

import json

import pytest

from dashboard.backend.infrastructure.llm.decision_parsing import fix_json_formatting


def test_valid_object_unchanged_and_parseable():
    out = fix_json_formatting('{"action": "buy", "qty": 5}')
    assert json.loads(out) == {"action": "buy", "qty": 5}


def test_missing_comma_between_objects_newline():
    # Fix 1: }\n{ -> },\n{
    assert fix_json_formatting('{"a":1}\n{"b":2}') == '{"a":1},\n{"b":2}'


def test_missing_comma_between_objects_no_space():
    # Fix 1b: }{ -> },{
    assert fix_json_formatting('{"a":1}{"b":2}') == '{"a":1},{"b":2}'


def test_trailing_comma_in_object_removed():
    out = fix_json_formatting('{"a": 1,}')
    assert out == '{"a": 1}'
    assert json.loads(out) == {"a": 1}


def test_trailing_comma_in_array_removed():
    out = fix_json_formatting('[1, 2, 3,]')
    assert out == '[1, 2, 3]'
    assert json.loads(out) == [1, 2, 3]


def test_extra_closing_brace_before_final_bracket_removed():
    # Fix 4: trailing }] -> ]  (drops an extra closing brace)
    out = fix_json_formatting('[{"a":1}}]')
    assert out == '[{"a":1}]'
    assert json.loads(out) == [{"a": 1}]


def test_collapse_bracket_brace_bracket():
    # Fix 3: ]}] -> ]
    assert fix_json_formatting('xx]}]') == 'xx]'


def test_single_quotes_not_supported():
    out = fix_json_formatting("{'a': 1}")
    assert "'" in out  # not converted to double quotes
    with pytest.raises(json.JSONDecodeError):
        json.loads(out)


def test_unquoted_keys_not_supported():
    out = fix_json_formatting('{a: 1}')
    with pytest.raises(json.JSONDecodeError):
        json.loads(out)


def test_code_fences_not_stripped():
    out = fix_json_formatting('```json\n{"a": 1}\n```')
    assert '```' in out  # current behavior: fences are NOT removed


def test_surrounding_text_not_stripped():
    out = fix_json_formatting('Here is the result: {"a": 1}')
    assert out.startswith('Here is the result:')


def test_malformed_remains_invalid():
    out = fix_json_formatting('{"a": }')
    with pytest.raises(json.JSONDecodeError):
        json.loads(out)
