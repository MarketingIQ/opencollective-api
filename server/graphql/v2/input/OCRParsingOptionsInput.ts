import { GraphQLInputFieldConfig, GraphQLInputObjectType } from 'graphql';

import { GraphQLCurrency } from '../enum';

export type GraphQLOCRParsingOptionsInputType = {
  currency: string;
};

export const GraphQLOCRParsingOptionsInput = new GraphQLInputObjectType({
  name: 'OCRParsingOptionsInput',
  description: 'To configure the OCR parsing',
  fields: (): Record<keyof GraphQLOCRParsingOptionsInputType, GraphQLInputFieldConfig> => ({
    currency: {
      type: GraphQLCurrency,
      defaultValue: null,
      description: "The currency that you'd like to use for the amounts",
    },
  }),
});
