import React from 'react';

import type { CSSProperties } from '@actual-app/components/styles';
import { View } from '@actual-app/components/view';
import type { RuleConditionEntity } from '@actual-app/core/types/models';

import { ConditionsOpMenu } from './ConditionsOpMenu';
import { FilterExpression } from './FilterExpression';

type AppliedFiltersProps = {
  conditions: RuleConditionEntity[];
  onUpdate: (
    filter: RuleConditionEntity,
    newFilter: RuleConditionEntity,
  ) => void;
  onDelete: (filter: RuleConditionEntity) => void;
  conditionsOp: 'and' | 'or';
  onConditionsOpChange: (value: 'and' | 'or') => void;
  style?: CSSProperties;
  // The currency of the amounts when it is not the currency of the budget
  currency?: string | null;
};

export function AppliedFilters({
  conditions,
  onUpdate,
  onDelete,
  conditionsOp,
  onConditionsOpChange,
  style = {},
  currency,
}: AppliedFiltersProps) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        flexWrap: 'wrap',
        ...style,
      }}
    >
      <ConditionsOpMenu
        conditionsOp={conditionsOp}
        onChange={onConditionsOpChange}
        conditions={conditions}
      />
      {conditions.map((filter: RuleConditionEntity, i: number) => (
        <FilterExpression
          key={i}
          customName={filter.customName}
          field={filter.field}
          op={filter.op}
          value={filter.value}
          options={filter.options}
          currency={currency}
          onChange={newFilter => onUpdate(filter, newFilter)}
          onDelete={() => onDelete(filter)}
        />
      ))}
    </View>
  );
}
