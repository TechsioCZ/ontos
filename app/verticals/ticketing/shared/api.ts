import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  Schema,
} from '@modern-js/plugin-bff/effect-client';
import {
  deleteSelectOptionActionHeadersSchema,
  deleteSelectOptionActionFailureSchemas,
  deleteSelectOptionActionOutcomeSchema,
  deleteSelectOptionActionPayloadSchema,
} from './actions/delete-select-option';

import {
  createMultiSelectOptionAndSelectActionHeadersSchema,
  createMultiSelectOptionAndSelectActionFailureSchemas,
  createMultiSelectOptionAndSelectActionOutcomeSchema,
  createMultiSelectOptionAndSelectActionPayloadSchema,
} from './actions/create-multi-select-option-and-select';

import {
  reorderMultiSelectOptionsActionHeadersSchema,
  reorderMultiSelectOptionsActionFailureSchemas,
  reorderMultiSelectOptionsActionOutcomeSchema,
  reorderMultiSelectOptionsActionPayloadSchema,
} from './actions/reorder-multi-select-options';

import {
  updateMultiSelectOptionActionHeadersSchema,
  updateMultiSelectOptionActionFailureSchemas,
  updateMultiSelectOptionActionOutcomeSchema,
  updateMultiSelectOptionActionPayloadSchema,
} from './actions/update-multi-select-option';

import {
  updateMultiSelectPropertyValueActionHeadersSchema,
  updateMultiSelectPropertyValueActionFailureSchemas,
  updateMultiSelectPropertyValueActionOutcomeSchema,
  updateMultiSelectPropertyValueActionPayloadSchema,
} from './actions/update-multi-select-property-value';

import {
  createMultiSelectOptionActionHeadersSchema,
  createMultiSelectOptionActionFailureSchemas,
  createMultiSelectOptionActionOutcomeSchema,
  createMultiSelectOptionActionPayloadSchema,
} from './actions/create-multi-select-option';

import {
  createMultiSelectPropertyDefinitionActionHeadersSchema,
  createMultiSelectPropertyDefinitionActionFailureSchemas,
  createMultiSelectPropertyDefinitionActionOutcomeSchema,
  createMultiSelectPropertyDefinitionActionPayloadSchema,
} from './actions/create-multi-select-property-definition';

import {
  updateTaskContentActionHeadersSchema,
  updateTaskContentActionFailureSchemas,
  updateTaskContentActionOutcomeSchema,
  updateTaskContentActionPayloadSchema,
} from './actions/update-task-content';
import {
  updateStatusOptionActionHeadersSchema,
  updateStatusOptionActionFailureSchemas,
  updateStatusOptionActionOutcomeSchema,
  updateStatusOptionActionPayloadSchema,
} from './actions/update-status-option';

import {
  createStatusOptionActionHeadersSchema,
  createStatusOptionActionFailureSchemas,
  createStatusOptionActionOutcomeSchema,
  createStatusOptionActionPayloadSchema,
} from './actions/create-status-option';

import {
  updateStatusPropertyValueActionHeadersSchema,
  updateStatusPropertyValueActionFailureSchemas,
  updateStatusPropertyValueActionOutcomeSchema,
  updateStatusPropertyValueActionPayloadSchema,
} from './actions/update-status-property-value';

import {
  configureStatusDefaultActionHeadersSchema,
  configureStatusDefaultActionFailureSchemas,
  configureStatusDefaultActionOutcomeSchema,
  configureStatusDefaultActionPayloadSchema,
} from './actions/configure-status-default';

import {
  createStatusPropertyDefinitionActionHeadersSchema,
  createStatusPropertyDefinitionActionFailureSchemas,
  createStatusPropertyDefinitionActionOutcomeSchema,
  createStatusPropertyDefinitionActionPayloadSchema,
} from './actions/create-status-property-definition';
import {
  configureDateRangeTimeSupportActionHeadersSchema,
  configureDateRangeTimeSupportActionFailureSchemas,
  configureDateRangeTimeSupportActionOutcomeSchema,
  configureDateRangeTimeSupportActionPayloadSchema,
} from './actions/configure-date-range-time-support';

import {
  updateDateRangePropertyValueActionHeadersSchema,
  updateDateRangePropertyValueActionFailureSchemas,
  updateDateRangePropertyValueActionOutcomeSchema,
  updateDateRangePropertyValueActionPayloadSchema,
} from './actions/update-date-range-property-value';

import {
  createDateRangePropertyDefinitionActionHeadersSchema,
  createDateRangePropertyDefinitionActionFailureSchemas,
  createDateRangePropertyDefinitionActionOutcomeSchema,
  createDateRangePropertyDefinitionActionPayloadSchema,
} from './actions/create-date-range-property-definition';
import {
  uploadFilesMediaItemsActionHeadersSchema,
  uploadFilesMediaItemsActionFailureSchemas,
  uploadFilesMediaItemsActionOutcomeSchema,
  uploadFilesMediaItemsActionPayloadSchema,
} from './actions/upload-files-media-items.ts';

import {
  duplicateTaskActionFailureSchemas,
  duplicateTaskActionHeadersSchema,
  duplicateTaskActionOutcomeSchema,
  duplicateTaskActionPayloadSchema,
} from './actions/duplicate-task';
import {
  configureIdPropertyPrefixActionFailureSchemas,
  configureIdPropertyPrefixActionHeadersSchema,
  configureIdPropertyPrefixActionOutcomeSchema,
  configureIdPropertyPrefixActionPayloadSchema,
} from './actions/configure-id-property-prefix';
import {
  createIdPropertyDefinitionActionFailureSchemas,
  createIdPropertyDefinitionActionHeadersSchema,
  createIdPropertyDefinitionActionOutcomeSchema,
  createIdPropertyDefinitionActionPayloadSchema,
} from './actions/create-id-property-definition';
import {
  createFilesMediaPropertyDefinitionActionFailureSchemas,
  createFilesMediaPropertyDefinitionActionHeadersSchema,
  createFilesMediaPropertyDefinitionActionOutcomeSchema,
  createFilesMediaPropertyDefinitionActionPayloadSchema,
} from './actions/create-files-media-property-definition.ts';
import {
  uploadFilesMediaItemActionFailureSchemas,
  uploadFilesMediaItemActionHeadersSchema,
  uploadFilesMediaItemActionOutcomeSchema,
  uploadFilesMediaItemActionPayloadSchema,
} from './actions/upload-files-media-item.ts';
import { queryTaskPersonValuesResponseSchema } from './person-query';
import {
  configurePersonPropertyCardinalityActionFailureSchemas,
  configurePersonPropertyCardinalityActionHeadersSchema,
  configurePersonPropertyCardinalityActionOutcomeSchema,
  configurePersonPropertyCardinalityActionPayloadSchema,
} from './actions/configure-person-property-cardinality';
import {
  createPersonPropertyDefinitionActionFailureSchemas,
  createPersonPropertyDefinitionActionHeadersSchema,
  createPersonPropertyDefinitionActionOutcomeSchema,
  createPersonPropertyDefinitionActionPayloadSchema,
} from './actions/create-person-property-definition';
import {
  updatePersonPropertyValueActionFailureSchemas,
  updatePersonPropertyValueActionHeadersSchema,
  updatePersonPropertyValueActionOutcomeSchema,
  updatePersonPropertyValueActionPayloadSchema,
} from './actions/update-person-property-value';
import {
  createDatePropertyDefinitionActionFailureSchemas,
  createDatePropertyDefinitionActionHeadersSchema,
  createDatePropertyDefinitionActionOutcomeSchema,
  createDatePropertyDefinitionActionPayloadSchema,
} from './actions/create-date-property-definition';
import {
  updateDatePropertyValueActionFailureSchemas,
  updateDatePropertyValueActionHeadersSchema,
  updateDatePropertyValueActionOutcomeSchema,
  updateDatePropertyValueActionPayloadSchema,
} from './actions/update-date-property-value';
import {
  configurePrincipalTimeZonePreferenceActionFailureSchemas,
  configurePrincipalTimeZonePreferenceActionHeadersSchema,
  configurePrincipalTimeZonePreferenceActionOutcomeSchema,
  configurePrincipalTimeZonePreferenceActionPayloadSchema,
} from './actions/configure-principal-time-zone-preference';
import {
  createIntrinsicPropertyDefinitionActionFailureSchemas,
  createIntrinsicPropertyDefinitionActionHeadersSchema,
  createIntrinsicPropertyDefinitionActionOutcomeSchema,
  createIntrinsicPropertyDefinitionActionPayloadSchema,
} from './actions/create-intrinsic-property-definition';
import {
  createPhonePropertyDefinitionActionHeadersSchema,
  createPhonePropertyDefinitionActionFailureSchemas,
  createPhonePropertyDefinitionActionOutcomeSchema,
  createPhonePropertyDefinitionActionPayloadSchema,
} from './actions/create-phone-property-definition';
import {
  updatePhonePropertyValueActionHeadersSchema,
  updatePhonePropertyValueActionFailureSchemas,
  updatePhonePropertyValueActionOutcomeSchema,
  updatePhonePropertyValueActionPayloadSchema,
} from './actions/update-phone-property-value';
import {
  createEmailPropertyDefinitionActionFailureSchemas,
  createEmailPropertyDefinitionActionHeadersSchema,
  createEmailPropertyDefinitionActionOutcomeSchema,
  createEmailPropertyDefinitionActionPayloadSchema,
} from './actions/create-email-property-definition';
import {
  updateEmailPropertyValueActionFailureSchemas,
  updateEmailPropertyValueActionHeadersSchema,
  updateEmailPropertyValueActionOutcomeSchema,
  updateEmailPropertyValueActionPayloadSchema,
} from './actions/update-email-property-value';
import {
  createUrlPropertyDefinitionActionFailureSchemas,
  createUrlPropertyDefinitionActionHeadersSchema,
  createUrlPropertyDefinitionActionOutcomeSchema,
  createUrlPropertyDefinitionActionPayloadSchema,
} from './actions/create-url-property-definition';
import {
  updateUrlPropertyValueActionFailureSchemas,
  updateUrlPropertyValueActionHeadersSchema,
  updateUrlPropertyValueActionOutcomeSchema,
  updateUrlPropertyValueActionPayloadSchema,
} from './actions/update-url-property-value';
import {
  configureSelectOptionOrderActionHeadersSchema,
  configureSelectOptionOrderActionFailureSchemas,
  configureSelectOptionOrderActionOutcomeSchema,
  configureSelectOptionOrderActionPayloadSchema,
} from './actions/configure-select-option-order';
import {
  createSelectOptionAndSelectActionHeadersSchema,
  createSelectOptionAndSelectActionFailureSchemas,
  createSelectOptionAndSelectActionOutcomeSchema,
  createSelectOptionAndSelectActionPayloadSchema,
} from './actions/create-select-option-and-select';
import {
  updateSelectPropertyValueActionHeadersSchema,
  updateSelectPropertyValueActionFailureSchemas,
  updateSelectPropertyValueActionOutcomeSchema,
  updateSelectPropertyValueActionPayloadSchema,
} from './actions/update-select-property-value';
import {
  updateSelectOptionActionHeadersSchema,
  updateSelectOptionActionFailureSchemas,
  updateSelectOptionActionOutcomeSchema,
  updateSelectOptionActionPayloadSchema,
} from './actions/update-select-option';
import {
  createSelectOptionActionHeadersSchema,
  createSelectOptionActionFailureSchemas,
  createSelectOptionActionOutcomeSchema,
  createSelectOptionActionPayloadSchema,
} from './actions/create-select-option';
import {
  createSelectPropertyDefinitionActionHeadersSchema,
  createSelectPropertyDefinitionActionFailureSchemas,
  createSelectPropertyDefinitionActionOutcomeSchema,
  createSelectPropertyDefinitionActionPayloadSchema,
} from './actions/create-select-property-definition';
import {
  configureNumberPropertyFormatActionHeadersSchema,
  configureNumberPropertyFormatActionFailureSchemas,
  configureNumberPropertyFormatActionOutcomeSchema,
  configureNumberPropertyFormatActionPayloadSchema,
} from './actions/configure-number-property-format';
import {
  createNumberPropertyDefinitionActionHeadersSchema,
  createNumberPropertyDefinitionActionFailureSchemas,
  createNumberPropertyDefinitionActionOutcomeSchema,
  createNumberPropertyDefinitionActionPayloadSchema,
} from './actions/create-number-property-definition';
import {
  updateNumberPropertyValueActionHeadersSchema,
  updateNumberPropertyValueActionFailureSchemas,
  updateNumberPropertyValueActionOutcomeSchema,
  updateNumberPropertyValueActionPayloadSchema,
} from './actions/update-number-property-value';
import {
  updateTextPropertyValueActionHeadersSchema,
  updateTextPropertyValueActionFailureSchemas,
  updateTextPropertyValueActionOutcomeSchema,
  updateTextPropertyValueActionPayloadSchema,
} from './actions/update-text-property-value';

import {
  createTextPropertyDefinitionActionHeadersSchema,
  createTextPropertyDefinitionActionFailureSchemas,
  createTextPropertyDefinitionActionOutcomeSchema,
  createTextPropertyDefinitionActionPayloadSchema,
} from './actions/create-text-property-definition';

import {
  transitionTaskRetentionActionHeadersSchema,
  transitionTaskRetentionActionFailureSchemas,
  transitionTaskRetentionActionOutcomeSchema,
  transitionTaskRetentionActionPayloadSchema,
} from './actions/transition-task-retention';

import {
  deleteTaskPropertyDefinitionActionHeadersSchema,
  deleteTaskPropertyDefinitionActionFailureSchemas,
  deleteTaskPropertyDefinitionActionOutcomeSchema,
  deleteTaskPropertyDefinitionActionPayloadSchema,
} from './actions/delete-task-property-definition';

import {
  duplicateTaskPropertyDefinitionActionHeadersSchema,
  duplicateTaskPropertyDefinitionActionFailureSchemas,
  duplicateTaskPropertyDefinitionActionOutcomeSchema,
  duplicateTaskPropertyDefinitionActionPayloadSchema,
} from './actions/duplicate-task-property-definition';

import {
  configureTaskPropertyDefinitionActionHeadersSchema,
  configureTaskPropertyDefinitionActionFailureSchemas,
  configureTaskPropertyDefinitionActionOutcomeSchema,
  configureTaskPropertyDefinitionActionPayloadSchema,
} from './actions/configure-task-property-definition';

import {
  createCheckboxPropertyDefinitionActionHeadersSchema,
  createCheckboxPropertyDefinitionActionFailureSchemas,
  createCheckboxPropertyDefinitionActionOutcomeSchema,
  createCheckboxPropertyDefinitionActionPayloadSchema,
} from './actions/create-checkbox-property-definition';

import {
  createTaskActionHeadersSchema,
  createTaskActionFailureSchemas,
  createTaskActionOutcomeSchema,
  createTaskActionPayloadSchema,
} from './actions/create-task';
import {
  createTaskCollectionActionHeadersSchema,
  createTaskCollectionActionFailureSchemas,
  createTaskCollectionActionOutcomeSchema,
  createTaskCollectionActionPayloadSchema,
} from './actions/create-task-collection';
import {
  updateCheckboxPropertyValueActionHeadersSchema,
  updateCheckboxPropertyValueActionFailureSchemas,
  updateCheckboxPropertyValueActionOutcomeSchema,
  updateCheckboxPropertyValueActionPayloadSchema,
} from './actions/update-checkbox-property-value';
import { filterTaskCheckboxValuesResponseSchema } from './checkbox-filter';
import { groupTaskDateValuesResponseSchema } from './date-grouping';
import { groupTaskDateRangeValuesResponseSchema } from './date-range-grouping';
import { emailQueryOperationSchema, queryTaskEmailValuesResponseSchema } from './email-query';
import {
  queryIntrinsicTaskPropertiesPayloadSchema,
  queryIntrinsicTaskPropertiesResponseSchema,
} from './intrinsic-task-property-query';
import {
  coreSdkOperationFailureSchemas,
  operationContextHeadersSchema,
} from './core-sdk-operation';
import { coreReferenceRequestSchema, coreReferenceResponseSchema } from './core-reference';
import { searchEligiblePeopleResponseSchema } from './person-directory-search';
import { taskCollectionAggregateSchema } from './task-collection';
import { taskPropertyDeletionImpactSchema } from './task-property-deletion-impact';
import {
  taskPropertyDefinitionEditCapabilitySchema,
  taskPropertyEditCapabilitySchema,
} from './task-property-edit-capability';
import { taskPropertyWorkspaceSchema } from './task-property-workspace';
import {
  queryTaskPropertyValuesPayloadSchema,
  queryTaskPropertyValuesResponseSchema,
} from './task-property-query';
import { queryTaskUrlValuesPayloadSchema, queryTaskUrlValuesResponseSchema } from './url-query';

export type {
  DeleteSelectOptionActionFailure,
  DeleteSelectOptionActionOutcome,
  DeleteSelectOptionActionPayload,
  DeleteSelectOptionActionResponse,
} from './actions/delete-select-option';
export type {
  CreateMultiSelectOptionAndSelectActionFailure,
  CreateMultiSelectOptionAndSelectActionOutcome,
  CreateMultiSelectOptionAndSelectActionPayload,
  CreateMultiSelectOptionAndSelectActionResponse,
} from './actions/create-multi-select-option-and-select';
export type {
  CreateMultiSelectOptionActionFailure,
  CreateMultiSelectOptionActionOutcome,
  CreateMultiSelectOptionActionPayload,
  CreateMultiSelectOptionActionResponse,
} from './actions/create-multi-select-option';
export type {
  CreateMultiSelectPropertyDefinitionActionFailure,
  CreateMultiSelectPropertyDefinitionActionOutcome,
  CreateMultiSelectPropertyDefinitionActionPayload,
  CreateMultiSelectPropertyDefinitionActionResponse,
} from './actions/create-multi-select-property-definition';
export type {
  ReorderMultiSelectOptionsActionFailure,
  ReorderMultiSelectOptionsActionOutcome,
  ReorderMultiSelectOptionsActionPayload,
  ReorderMultiSelectOptionsActionResponse,
} from './actions/reorder-multi-select-options';
export type {
  UpdateMultiSelectOptionActionFailure,
  UpdateMultiSelectOptionActionOutcome,
  UpdateMultiSelectOptionActionPayload,
  UpdateMultiSelectOptionActionResponse,
} from './actions/update-multi-select-option';
export type {
  UpdateMultiSelectPropertyValueActionFailure,
  UpdateMultiSelectPropertyValueActionOutcome,
  UpdateMultiSelectPropertyValueActionPayload,
  UpdateMultiSelectPropertyValueActionResponse,
} from './actions/update-multi-select-property-value';
export type {
  UpdateTaskContentActionFailure,
  UpdateTaskContentActionOutcome,
  UpdateTaskContentActionPayload,
  UpdateTaskContentActionResponse,
} from './actions/update-task-content';
export type {
  ConfigureStatusDefaultActionFailure,
  ConfigureStatusDefaultActionOutcome,
  ConfigureStatusDefaultActionPayload,
  ConfigureStatusDefaultActionResponse,
} from './actions/configure-status-default';
export type {
  CreateStatusOptionActionFailure,
  CreateStatusOptionActionOutcome,
  CreateStatusOptionActionPayload,
  CreateStatusOptionActionResponse,
} from './actions/create-status-option';
export type {
  CreateStatusPropertyDefinitionActionFailure,
  CreateStatusPropertyDefinitionActionOutcome,
  CreateStatusPropertyDefinitionActionPayload,
  CreateStatusPropertyDefinitionActionResponse,
} from './actions/create-status-property-definition';
export type {
  UpdateStatusOptionActionFailure,
  UpdateStatusOptionActionOutcome,
  UpdateStatusOptionActionPayload,
  UpdateStatusOptionActionResponse,
} from './actions/update-status-option';
export type {
  UpdateStatusPropertyValueActionFailure,
  UpdateStatusPropertyValueActionOutcome,
  UpdateStatusPropertyValueActionPayload,
  UpdateStatusPropertyValueActionResponse,
} from './actions/update-status-property-value';
export type {
  ConfigureDateRangeTimeSupportActionFailure,
  ConfigureDateRangeTimeSupportActionOutcome,
  ConfigureDateRangeTimeSupportActionPayload,
  ConfigureDateRangeTimeSupportActionResponse,
} from './actions/configure-date-range-time-support';
export type {
  CreateDateRangePropertyDefinitionActionFailure,
  CreateDateRangePropertyDefinitionActionOutcome,
  CreateDateRangePropertyDefinitionActionPayload,
  CreateDateRangePropertyDefinitionActionResponse,
} from './actions/create-date-range-property-definition';
export type {
  UpdateDateRangePropertyValueActionFailure,
  UpdateDateRangePropertyValueActionOutcome,
  UpdateDateRangePropertyValueActionPayload,
  UpdateDateRangePropertyValueActionResponse,
} from './actions/update-date-range-property-value';
export type {
  ConfigureIdPropertyPrefixActionFailure,
  ConfigureIdPropertyPrefixActionOutcome,
  ConfigureIdPropertyPrefixActionPayload,
  ConfigureIdPropertyPrefixActionResponse,
} from './actions/configure-id-property-prefix';
export type {
  ConfigurePrincipalTimeZonePreferenceActionFailure,
  ConfigurePrincipalTimeZonePreferenceActionOutcome,
  ConfigurePrincipalTimeZonePreferenceActionPayload,
  ConfigurePrincipalTimeZonePreferenceActionResponse,
} from './actions/configure-principal-time-zone-preference';
export type {
  ConfigurePersonPropertyCardinalityActionFailure,
  ConfigurePersonPropertyCardinalityActionOutcome,
  ConfigurePersonPropertyCardinalityActionPayload,
  ConfigurePersonPropertyCardinalityActionResponse,
} from './actions/configure-person-property-cardinality';
export type {
  CreatePersonPropertyDefinitionActionFailure,
  CreatePersonPropertyDefinitionActionOutcome,
  CreatePersonPropertyDefinitionActionPayload,
  CreatePersonPropertyDefinitionActionResponse,
} from './actions/create-person-property-definition';
export type {
  UpdatePersonPropertyValueActionFailure,
  UpdatePersonPropertyValueActionOutcome,
  UpdatePersonPropertyValueActionPayload,
  UpdatePersonPropertyValueActionResponse,
} from './actions/update-person-property-value';
export type {
  CreateEmailPropertyDefinitionActionFailure,
  CreateEmailPropertyDefinitionActionOutcome,
  CreateEmailPropertyDefinitionActionPayload,
  CreateEmailPropertyDefinitionActionResponse,
} from './actions/create-email-property-definition';
export type {
  CreateFilesMediaPropertyDefinitionActionFailure,
  CreateFilesMediaPropertyDefinitionActionOutcome,
  CreateFilesMediaPropertyDefinitionActionPayload,
  CreateFilesMediaPropertyDefinitionActionResponse,
} from './actions/create-files-media-property-definition.ts';
export type {
  CreateDatePropertyDefinitionActionFailure,
  CreateDatePropertyDefinitionActionOutcome,
  CreateDatePropertyDefinitionActionPayload,
  CreateDatePropertyDefinitionActionResponse,
} from './actions/create-date-property-definition';
export type {
  UpdateEmailPropertyValueActionFailure,
  UpdateEmailPropertyValueActionOutcome,
  UpdateEmailPropertyValueActionPayload,
  UpdateEmailPropertyValueActionResponse,
} from './actions/update-email-property-value';
export type {
  ConfigureNumberPropertyFormatActionFailure,
  ConfigureNumberPropertyFormatActionOutcome,
  ConfigureNumberPropertyFormatActionPayload,
  ConfigureNumberPropertyFormatActionResponse,
} from './actions/configure-number-property-format';
export type {
  ConfigureSelectOptionOrderActionFailure,
  ConfigureSelectOptionOrderActionOutcome,
  ConfigureSelectOptionOrderActionPayload,
  ConfigureSelectOptionOrderActionResponse,
} from './actions/configure-select-option-order';
export type {
  CreateNumberPropertyDefinitionActionFailure,
  CreateNumberPropertyDefinitionActionOutcome,
  CreateNumberPropertyDefinitionActionPayload,
  CreateNumberPropertyDefinitionActionResponse,
} from './actions/create-number-property-definition';
export type {
  UpdateNumberPropertyValueActionFailure,
  UpdateNumberPropertyValueActionOutcome,
  UpdateNumberPropertyValueActionPayload,
  UpdateNumberPropertyValueActionResponse,
} from './actions/update-number-property-value';
export type {
  CreateTextPropertyDefinitionActionFailure,
  CreateTextPropertyDefinitionActionOutcome,
  CreateTextPropertyDefinitionActionPayload,
  CreateTextPropertyDefinitionActionResponse,
} from './actions/create-text-property-definition';
export type {
  UpdateTextPropertyValueActionFailure,
  UpdateTextPropertyValueActionOutcome,
  UpdateTextPropertyValueActionPayload,
  UpdateTextPropertyValueActionResponse,
} from './actions/update-text-property-value';
export type {
  ConfigureTaskPropertyDefinitionActionFailure,
  ConfigureTaskPropertyDefinitionActionOutcome,
  ConfigureTaskPropertyDefinitionActionPayload,
  ConfigureTaskPropertyDefinitionActionResponse,
} from './actions/configure-task-property-definition';
export type {
  CreateCheckboxPropertyDefinitionActionFailure,
  CreateCheckboxPropertyDefinitionActionOutcome,
  CreateCheckboxPropertyDefinitionActionPayload,
  CreateCheckboxPropertyDefinitionActionResponse,
} from './actions/create-checkbox-property-definition';
export type {
  CreateIntrinsicPropertyDefinitionActionFailure,
  CreateIntrinsicPropertyDefinitionActionOutcome,
  CreateIntrinsicPropertyDefinitionActionPayload,
  CreateIntrinsicPropertyDefinitionActionResponse,
} from './actions/create-intrinsic-property-definition';
export type {
  CreateIdPropertyDefinitionActionFailure,
  CreateIdPropertyDefinitionActionOutcome,
  CreateIdPropertyDefinitionActionPayload,
  CreateIdPropertyDefinitionActionResponse,
} from './actions/create-id-property-definition';
export type {
  CreatePhonePropertyDefinitionActionFailure,
  CreatePhonePropertyDefinitionActionOutcome,
  CreatePhonePropertyDefinitionActionPayload,
  CreatePhonePropertyDefinitionActionResponse,
} from './actions/create-phone-property-definition';
export type {
  CreateSelectOptionAndSelectActionFailure,
  CreateSelectOptionAndSelectActionOutcome,
  CreateSelectOptionAndSelectActionPayload,
  CreateSelectOptionAndSelectActionResponse,
} from './actions/create-select-option-and-select';
export type {
  CreateSelectOptionActionFailure,
  CreateSelectOptionActionOutcome,
  CreateSelectOptionActionPayload,
  CreateSelectOptionActionResponse,
} from './actions/create-select-option';
export type {
  CreateSelectPropertyDefinitionActionFailure,
  CreateSelectPropertyDefinitionActionOutcome,
  CreateSelectPropertyDefinitionActionPayload,
  CreateSelectPropertyDefinitionActionResponse,
} from './actions/create-select-property-definition';
export type {
  CreateTaskActionFailure,
  CreateTaskActionOutcome,
  CreateTaskActionPayload,
  CreateTaskActionResponse,
} from './actions/create-task';
export type {
  CreateTaskCollectionActionFailure,
  CreateTaskCollectionActionOutcome,
  CreateTaskCollectionActionPayload,
  CreateTaskCollectionActionResponse,
} from './actions/create-task-collection';
export type {
  CreateUrlPropertyDefinitionActionFailure,
  CreateUrlPropertyDefinitionActionOutcome,
  CreateUrlPropertyDefinitionActionPayload,
  CreateUrlPropertyDefinitionActionResponse,
} from './actions/create-url-property-definition';
export type {
  DeleteTaskPropertyDefinitionActionFailure,
  DeleteTaskPropertyDefinitionActionOutcome,
  DeleteTaskPropertyDefinitionActionPayload,
  DeleteTaskPropertyDefinitionActionResponse,
} from './actions/delete-task-property-definition';
export type {
  DuplicateTaskPropertyDefinitionActionFailure,
  DuplicateTaskPropertyDefinitionActionOutcome,
  DuplicateTaskPropertyDefinitionActionPayload,
  DuplicateTaskPropertyDefinitionActionResponse,
} from './actions/duplicate-task-property-definition';
export type {
  DuplicateTaskActionFailure,
  DuplicateTaskActionOutcome,
  DuplicateTaskActionPayload,
  DuplicateTaskActionResponse,
} from './actions/duplicate-task';
export type {
  UpdateCheckboxPropertyValueActionFailure,
  UpdateCheckboxPropertyValueActionOutcome,
  UpdateCheckboxPropertyValueActionPayload,
  UpdateCheckboxPropertyValueActionResponse,
} from './actions/update-checkbox-property-value';
export type {
  UpdateDatePropertyValueActionFailure,
  UpdateDatePropertyValueActionOutcome,
  UpdateDatePropertyValueActionPayload,
  UpdateDatePropertyValueActionResponse,
} from './actions/update-date-property-value';
export type {
  UpdatePhonePropertyValueActionFailure,
  UpdatePhonePropertyValueActionOutcome,
  UpdatePhonePropertyValueActionPayload,
  UpdatePhonePropertyValueActionResponse,
} from './actions/update-phone-property-value';
export type {
  UpdateUrlPropertyValueActionFailure,
  UpdateUrlPropertyValueActionOutcome,
  UpdateUrlPropertyValueActionPayload,
  UpdateUrlPropertyValueActionResponse,
} from './actions/update-url-property-value';
export type {
  UploadFilesMediaItemActionFailure,
  UploadFilesMediaItemActionOutcome,
  UploadFilesMediaItemActionPayload,
  UploadFilesMediaItemActionResponse,
} from './actions/upload-files-media-item.ts';
export type {
  UploadFilesMediaItemsActionFailure,
  UploadFilesMediaItemsActionOutcome,
  UploadFilesMediaItemsActionPayload,
  UploadFilesMediaItemsActionResponse,
} from './actions/upload-files-media-items.ts';
export type {
  TransitionTaskRetentionActionFailure,
  TransitionTaskRetentionActionOutcome,
  TransitionTaskRetentionActionPayload,
  TransitionTaskRetentionActionResponse,
} from './actions/transition-task-retention';
export type {
  UpdateSelectOptionActionFailure,
  UpdateSelectOptionActionOutcome,
  UpdateSelectOptionActionPayload,
  UpdateSelectOptionActionResponse,
} from './actions/update-select-option';
export type {
  UpdateSelectPropertyValueActionFailure,
  UpdateSelectPropertyValueActionOutcome,
  UpdateSelectPropertyValueActionPayload,
  UpdateSelectPropertyValueActionResponse,
} from './actions/update-select-property-value';
export type { TaskCollectionAggregate } from './task-collection';
export type { TaskPropertyDeletionImpact } from './task-property-deletion-impact';
export type {
  TaskPropertyDefinitionEditCapability,
  TaskPropertyEditCapability,
} from './task-property-edit-capability';
export type { CoreReferenceRequest, CoreReferenceResponse } from './core-reference';
export {
  checkboxPropertyDefinitionSchema,
  datePropertyDefinitionSchema,
  emailPropertyDefinitionSchema,
  filesMediaPropertyDefinitionSchema,
  idPropertyDefinitionSchema,
  numberPropertyDefinitionSchema,
  personPropertyDefinitionSchema,
  phonePropertyDefinitionSchema,
  selectOptionOrderModeSchema,
  selectOptionSchema,
  selectPropertyDefinitionSchema,
  taskPropertyDefinitionSchema,
  textPropertyDefinitionSchema,
  urlPropertyDefinitionSchema,
} from './task-property-definition';
export type {
  CheckboxPropertyDefinition,
  DatePropertyDefinition,
  EmailPropertyDefinition,
  FilesMediaPropertyDefinition,
  IdPropertyDefinition,
  NumberPropertyDefinition,
  PersonPropertyDefinition,
  PhonePropertyDefinition,
  SelectOption,
  SelectOptionOrderMode,
  SelectPropertyDefinition,
  TaskPropertyDefinition,
  TextPropertyDefinition,
  UrlPropertyDefinition,
} from './task-property-definition';
export { phoneTelHref, validatePhoneValue } from './phone-value';
export type { PhoneValueValidationFailure, PhoneValueValidationResult } from './phone-value';
export { emailMailtoHref, parseEmailValue } from './email-value';
export type { ParsedEmailValue } from './email-value';
export type { TaskPropertyWorkspace } from './task-property-workspace';
export type {
  QueryTaskPropertyValuesPayload,
  QueryTaskPropertyValuesResponse,
  TaskPropertyQuery,
} from './task-property-query';
export {
  coreReferenceSchema,
  nullableTextDocumentSchema,
  textDocumentSchema,
  textInlineNodeSchema,
  textMarkSchema,
  textPropertyValueSchema,
} from './text-property';
export type {
  CoreReference,
  TextDocument,
  TextInlineNode,
  TextMark,
  TextPropertyValue,
} from './text-property';
export type { TextQueryOperation } from './text-query';
export type { NumberQueryOperation } from './number-query';
export type {
  FilterTaskCheckboxValuesPayload,
  FilterTaskCheckboxValuesResponse,
} from './checkbox-filter';
export type { QueryTaskUrlValuesPayload, QueryTaskUrlValuesResponse } from './url-query';
export type { QueryTaskEmailValuesPayload, QueryTaskEmailValuesResponse } from './email-query';
export type { GroupTaskDateValuesPayload, GroupTaskDateValuesResponse } from './date-grouping';
export type {
  GroupTaskDateRangeValuesPayload,
  GroupTaskDateRangeValuesResponse,
} from './date-range-grouping';
export type { QueryTaskPersonValuesPayload, QueryTaskPersonValuesResponse } from './person-query';
export type {
  SearchEligiblePeoplePayload,
  SearchEligiblePeopleResponse,
} from './person-directory-search';
export type {
  IntrinsicTaskPropertyQueryOperation,
  QueryIntrinsicTaskPropertiesPayload,
  QueryIntrinsicTaskPropertiesResponse,
} from './intrinsic-task-property-query';

export interface TicketingMarker {
  readonly appId: string;
  readonly build: string;
  readonly deployProfile: string;
  readonly packageName: string;
  readonly surface: string;
  readonly version: string;
}

export interface TicketingItem {
  readonly id: string;
  readonly marker: TicketingMarker;
  readonly title: string;
}

export interface TicketingReadiness {
  readonly checks: {
    readonly api: 'ready';
    readonly moduleFederation: 'ready';
    readonly ssr: 'ready';
    readonly translations: 'ready';
  };
  readonly marker: TicketingMarker;
  readonly status: 'ready';
  readonly versionSkew: 'none';
}

export interface TicketingListResponse {
  readonly items: readonly TicketingItem[];
}

export interface TicketingNotFound {
  readonly _tag: 'TicketingNotFound';
  readonly id: string;
}

export const ticketingMarkerSchema: Schema.Codec<TicketingMarker> = Schema.Struct({
  appId: Schema.String,
  build: Schema.String,
  deployProfile: Schema.String,
  packageName: Schema.String,
  surface: Schema.String,
  version: Schema.String,
});

export const ticketingItemSchema: Schema.Codec<TicketingItem> = Schema.Struct({
  id: Schema.String,
  marker: ticketingMarkerSchema,
  title: Schema.String,
});

export const ticketingReadinessSchema: Schema.Codec<TicketingReadiness> = Schema.Struct({
  checks: Schema.Struct({
    api: Schema.Literal('ready'),
    moduleFederation: Schema.Literal('ready'),
    ssr: Schema.Literal('ready'),
    translations: Schema.Literal('ready'),
  }),
  marker: ticketingMarkerSchema,
  status: Schema.Literal('ready'),
  versionSkew: Schema.Literal('none'),
});

export const ticketingNotFoundSchema: Schema.Codec<TicketingNotFound> = Schema.TaggedStruct(
  'TicketingNotFound',
  {
    id: Schema.String,
  },
).pipe(HttpApiSchema.status(404));

export interface OperationContext {
  method: string;
  operationId: string;
  routePath: string;
  source: 'client' | 'server' | 'generated-client' | 'effect-adapter' | 'data-platform' | 'unknown';
  traceId?: string;
}

const taskPersonQueryCommonFields = {
  group: Schema.optional(Schema.Literals(['true', 'false'])),
  search: Schema.optional(Schema.String),
  sort: Schema.optional(Schema.Literals(['ascending', 'descending'])),
};

const taskPersonHttpQuerySchema = Schema.Union([
  Schema.Struct({
    ...taskPersonQueryCommonFields,
    filter: Schema.Literals(['contains', 'doesNotContain']),
    principalId: Schema.String,
  }),
  Schema.Struct({
    ...taskPersonQueryCommonFields,
    filter: Schema.optional(Schema.Literals(['isEmpty', 'isNotEmpty'])),
  }),
]);

export const ticketingApi = HttpApi.make('TicketingApi').add(
  HttpApiGroup.make('ticketing')
    .add(
      HttpApiEndpoint.get('list', '/ticketing', {
        query: {
          limit: Schema.optional(Schema.FiniteFromString),
        },
        success: Schema.Struct({
          items: Schema.Array(ticketingItemSchema),
        }),
      }),
    )
    .add(
      HttpApiEndpoint.get('readiness', '/ticketing/readiness', {
        success: ticketingReadinessSchema,
      }),
    )
    .add(
      HttpApiEndpoint.get('get', '/ticketing/:id', {
        error: ticketingNotFoundSchema,
        params: {
          id: Schema.String,
        },
        success: ticketingItemSchema,
      }),
    )
    .add(
      HttpApiEndpoint.get('getTaskCollection', '/ticketing/task-collections/:collectionId', {
        error: coreSdkOperationFailureSchemas,
        headers: operationContextHeadersSchema,
        params: {
          collectionId: Schema.String,
        },
        success: taskCollectionAggregateSchema,
      }),
    )
    .add(
      HttpApiEndpoint.get(
        'searchEligiblePeople',
        '/ticketing/task-collections/:collectionId/person-directory',
        {
          error: coreSdkOperationFailureSchemas,
          headers: operationContextHeadersSchema,
          params: { collectionId: Schema.String },
          query: { query: Schema.String },
          success: searchEligiblePeopleResponseSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.get(
        'getTaskPropertyWorkspace',
        '/ticketing/task-collections/:collectionId/properties',
        {
          error: coreSdkOperationFailureSchemas,
          headers: operationContextHeadersSchema,
          params: { collectionId: Schema.String },
          query: {
            browserTimeZone: Schema.optional(Schema.String),
            locale: Schema.optional(Schema.String),
          },
          success: taskPropertyWorkspaceSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'queryIntrinsicTaskProperties',
        '/ticketing/task-collections/:collectionId/intrinsic-property-query',
        {
          error: coreSdkOperationFailureSchemas,
          headers: operationContextHeadersSchema,
          params: { collectionId: Schema.String },
          payload: queryIntrinsicTaskPropertiesPayloadSchema,
          success: queryIntrinsicTaskPropertiesResponseSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.get(
        'getTaskPropertyEditCapability',
        '/ticketing/task-collections/:collectionId/properties/edit-capability',
        {
          error: coreSdkOperationFailureSchemas,
          headers: operationContextHeadersSchema,
          params: { collectionId: Schema.String },
          success: taskPropertyEditCapabilitySchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.get(
        'getTaskPropertyDefinitionEditCapability',
        '/ticketing/task-collections/:collectionId/properties/definition-edit-capability',
        {
          error: coreSdkOperationFailureSchemas,
          headers: operationContextHeadersSchema,
          params: { collectionId: Schema.String },
          success: taskPropertyDefinitionEditCapabilitySchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post('queryTaskPropertyValues', '/ticketing/task-properties/query', {
        error: coreSdkOperationFailureSchemas,
        headers: operationContextHeadersSchema,
        payload: queryTaskPropertyValuesPayloadSchema,
        success: queryTaskPropertyValuesResponseSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('coreReference', '/ticketing/core-references', {
        error: coreSdkOperationFailureSchemas,
        headers: operationContextHeadersSchema,
        payload: coreReferenceRequestSchema,
        success: coreReferenceResponseSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('queryTaskUrlValues', '/ticketing/queries/task-url-values', {
        error: coreSdkOperationFailureSchemas,
        headers: operationContextHeadersSchema,
        payload: queryTaskUrlValuesPayloadSchema,
        success: queryTaskUrlValuesResponseSchema,
      }),
    )
    .add(
      HttpApiEndpoint.get(
        'filterTaskCheckboxValues',
        '/ticketing/task-collections/:collectionId/properties/:propertyDefinitionId/checkbox-filter',
        {
          error: coreSdkOperationFailureSchemas,
          headers: operationContextHeadersSchema,
          params: {
            collectionId: Schema.String,
            propertyDefinitionId: Schema.String,
          },
          query: { value: Schema.Literals(['true', 'false']) },
          success: filterTaskCheckboxValuesResponseSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.get(
        'queryTaskEmailValues',
        '/ticketing/task-collections/:collectionId/properties/:propertyDefinitionId/email-query',
        {
          error: coreSdkOperationFailureSchemas,
          headers: operationContextHeadersSchema,
          params: {
            collectionId: Schema.String,
            propertyDefinitionId: Schema.String,
          },
          query: {
            operation: emailQueryOperationSchema,
            query: Schema.String,
          },
          success: queryTaskEmailValuesResponseSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.get(
        'queryTaskPersonValues',
        '/ticketing/task-collections/:collectionId/properties/:propertyDefinitionId/person-query',
        {
          error: coreSdkOperationFailureSchemas,
          headers: operationContextHeadersSchema,
          params: {
            collectionId: Schema.String,
            propertyDefinitionId: Schema.String,
          },
          query: taskPersonHttpQuerySchema,
          success: queryTaskPersonValuesResponseSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.get(
        'getTaskPropertyDeletionImpact',
        '/ticketing/task-collections/:collectionId/properties/:propertyDefinitionId/deletion-impact',
        {
          error: coreSdkOperationFailureSchemas,
          headers: operationContextHeadersSchema,
          params: {
            collectionId: Schema.String,
            propertyDefinitionId: Schema.String,
          },
          success: taskPropertyDeletionImpactSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.get(
        'groupTaskDateValues',
        '/ticketing/task-collections/:collectionId/properties/:propertyDefinitionId/date-groups',
        {
          error: coreSdkOperationFailureSchemas,
          headers: operationContextHeadersSchema,
          params: {
            collectionId: Schema.String,
            propertyDefinitionId: Schema.String,
          },
          success: groupTaskDateValuesResponseSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.get(
        'groupTaskDateRangeValues',
        '/ticketing/task-collections/:collectionId/properties/:propertyDefinitionId/date-range-groups',
        {
          error: coreSdkOperationFailureSchemas,
          headers: operationContextHeadersSchema,
          params: {
            collectionId: Schema.String,
            propertyDefinitionId: Schema.String,
          },
          success: groupTaskDateRangeValuesResponseSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'createTaskCollectionAction',
        '/ticketing/actions/create-task-collection',
        {
          error: createTaskCollectionActionFailureSchemas,
          headers: createTaskCollectionActionHeadersSchema,
          payload: createTaskCollectionActionPayloadSchema,
          success: createTaskCollectionActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post('createTaskAction', '/ticketing/actions/create-task', {
        error: createTaskActionFailureSchemas,
        headers: createTaskActionHeadersSchema,
        payload: createTaskActionPayloadSchema,
        success: createTaskActionOutcomeSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post(
        'createCheckboxPropertyDefinitionAction',
        '/ticketing/actions/create-checkbox-property-definition',
        {
          error: createCheckboxPropertyDefinitionActionFailureSchemas,
          headers: createCheckboxPropertyDefinitionActionHeadersSchema,
          payload: createCheckboxPropertyDefinitionActionPayloadSchema,
          success: createCheckboxPropertyDefinitionActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'createIntrinsicPropertyDefinitionAction',
        '/ticketing/actions/create-intrinsic-property-definition',
        {
          error: createIntrinsicPropertyDefinitionActionFailureSchemas,
          headers: createIntrinsicPropertyDefinitionActionHeadersSchema,
          payload: createIntrinsicPropertyDefinitionActionPayloadSchema,
          success: createIntrinsicPropertyDefinitionActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'configurePrincipalTimeZonePreferenceAction',
        '/ticketing/actions/configure-principal-time-zone-preference',
        {
          error: configurePrincipalTimeZonePreferenceActionFailureSchemas,
          headers: configurePrincipalTimeZonePreferenceActionHeadersSchema,
          payload: configurePrincipalTimeZonePreferenceActionPayloadSchema,
          success: configurePrincipalTimeZonePreferenceActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'updateCheckboxPropertyValueAction',
        '/ticketing/actions/update-checkbox-property-value',
        {
          error: updateCheckboxPropertyValueActionFailureSchemas,
          headers: updateCheckboxPropertyValueActionHeadersSchema,
          payload: updateCheckboxPropertyValueActionPayloadSchema,
          success: updateCheckboxPropertyValueActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'createEmailPropertyDefinitionAction',
        '/ticketing/actions/create-email-property-definition',
        {
          error: createEmailPropertyDefinitionActionFailureSchemas,
          headers: createEmailPropertyDefinitionActionHeadersSchema,
          payload: createEmailPropertyDefinitionActionPayloadSchema,
          success: createEmailPropertyDefinitionActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'updateEmailPropertyValueAction',
        '/ticketing/actions/update-email-property-value',
        {
          error: updateEmailPropertyValueActionFailureSchemas,
          headers: updateEmailPropertyValueActionHeadersSchema,
          payload: updateEmailPropertyValueActionPayloadSchema,
          success: updateEmailPropertyValueActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'configureTaskPropertyDefinitionAction',
        '/ticketing/actions/configure-task-property-definition',
        {
          error: configureTaskPropertyDefinitionActionFailureSchemas,
          headers: configureTaskPropertyDefinitionActionHeadersSchema,
          payload: configureTaskPropertyDefinitionActionPayloadSchema,
          success: configureTaskPropertyDefinitionActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'duplicateTaskPropertyDefinitionAction',
        '/ticketing/actions/duplicate-task-property-definition',
        {
          error: duplicateTaskPropertyDefinitionActionFailureSchemas,
          headers: duplicateTaskPropertyDefinitionActionHeadersSchema,
          payload: duplicateTaskPropertyDefinitionActionPayloadSchema,
          success: duplicateTaskPropertyDefinitionActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'deleteTaskPropertyDefinitionAction',
        '/ticketing/actions/delete-task-property-definition',
        {
          error: deleteTaskPropertyDefinitionActionFailureSchemas,
          headers: deleteTaskPropertyDefinitionActionHeadersSchema,
          payload: deleteTaskPropertyDefinitionActionPayloadSchema,
          success: deleteTaskPropertyDefinitionActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'transitionTaskRetentionAction',
        '/ticketing/actions/transition-task-retention',
        {
          error: transitionTaskRetentionActionFailureSchemas,
          headers: transitionTaskRetentionActionHeadersSchema,
          payload: transitionTaskRetentionActionPayloadSchema,
          success: transitionTaskRetentionActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'createTextPropertyDefinitionAction',
        '/ticketing/actions/create-text-property-definition',
        {
          error: createTextPropertyDefinitionActionFailureSchemas,
          headers: createTextPropertyDefinitionActionHeadersSchema,
          payload: createTextPropertyDefinitionActionPayloadSchema,
          success: createTextPropertyDefinitionActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'updateTextPropertyValueAction',
        '/ticketing/actions/update-text-property-value',
        {
          error: updateTextPropertyValueActionFailureSchemas,
          headers: updateTextPropertyValueActionHeadersSchema,
          payload: updateTextPropertyValueActionPayloadSchema,
          success: updateTextPropertyValueActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'createNumberPropertyDefinitionAction',
        '/ticketing/actions/create-number-property-definition',
        {
          error: createNumberPropertyDefinitionActionFailureSchemas,
          headers: createNumberPropertyDefinitionActionHeadersSchema,
          payload: createNumberPropertyDefinitionActionPayloadSchema,
          success: createNumberPropertyDefinitionActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'updateNumberPropertyValueAction',
        '/ticketing/actions/update-number-property-value',
        {
          error: updateNumberPropertyValueActionFailureSchemas,
          headers: updateNumberPropertyValueActionHeadersSchema,
          payload: updateNumberPropertyValueActionPayloadSchema,
          success: updateNumberPropertyValueActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'configureNumberPropertyFormatAction',
        '/ticketing/actions/configure-number-property-format',
        {
          error: configureNumberPropertyFormatActionFailureSchemas,
          headers: configureNumberPropertyFormatActionHeadersSchema,
          payload: configureNumberPropertyFormatActionPayloadSchema,
          success: configureNumberPropertyFormatActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'createSelectPropertyDefinitionAction',
        '/ticketing/actions/create-select-property-definition',
        {
          error: createSelectPropertyDefinitionActionFailureSchemas,
          headers: createSelectPropertyDefinitionActionHeadersSchema,
          payload: createSelectPropertyDefinitionActionPayloadSchema,
          success: createSelectPropertyDefinitionActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post('createSelectOptionAction', '/ticketing/actions/create-select-option', {
        error: createSelectOptionActionFailureSchemas,
        headers: createSelectOptionActionHeadersSchema,
        payload: createSelectOptionActionPayloadSchema,
        success: createSelectOptionActionOutcomeSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('updateSelectOptionAction', '/ticketing/actions/update-select-option', {
        error: updateSelectOptionActionFailureSchemas,
        headers: updateSelectOptionActionHeadersSchema,
        payload: updateSelectOptionActionPayloadSchema,
        success: updateSelectOptionActionOutcomeSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post(
        'updateSelectPropertyValueAction',
        '/ticketing/actions/update-select-property-value',
        {
          error: updateSelectPropertyValueActionFailureSchemas,
          headers: updateSelectPropertyValueActionHeadersSchema,
          payload: updateSelectPropertyValueActionPayloadSchema,
          success: updateSelectPropertyValueActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'createSelectOptionAndSelectAction',
        '/ticketing/actions/create-select-option-and-select',
        {
          error: createSelectOptionAndSelectActionFailureSchemas,
          headers: createSelectOptionAndSelectActionHeadersSchema,
          payload: createSelectOptionAndSelectActionPayloadSchema,
          success: createSelectOptionAndSelectActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'configureSelectOptionOrderAction',
        '/ticketing/actions/configure-select-option-order',
        {
          error: configureSelectOptionOrderActionFailureSchemas,
          headers: configureSelectOptionOrderActionHeadersSchema,
          payload: configureSelectOptionOrderActionPayloadSchema,
          success: configureSelectOptionOrderActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'createUrlPropertyDefinitionAction',
        '/ticketing/actions/create-url-property-definition',
        {
          error: createUrlPropertyDefinitionActionFailureSchemas,
          headers: createUrlPropertyDefinitionActionHeadersSchema,
          payload: createUrlPropertyDefinitionActionPayloadSchema,
          success: createUrlPropertyDefinitionActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'updateUrlPropertyValueAction',
        '/ticketing/actions/update-url-property-value',
        {
          error: updateUrlPropertyValueActionFailureSchemas,
          headers: updateUrlPropertyValueActionHeadersSchema,
          payload: updateUrlPropertyValueActionPayloadSchema,
          success: updateUrlPropertyValueActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'createPhonePropertyDefinitionAction',
        '/ticketing/actions/create-phone-property-definition',
        {
          error: createPhonePropertyDefinitionActionFailureSchemas,
          headers: createPhonePropertyDefinitionActionHeadersSchema,
          payload: createPhonePropertyDefinitionActionPayloadSchema,
          success: createPhonePropertyDefinitionActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'updatePhonePropertyValueAction',
        '/ticketing/actions/update-phone-property-value',
        {
          error: updatePhonePropertyValueActionFailureSchemas,
          headers: updatePhonePropertyValueActionHeadersSchema,
          payload: updatePhonePropertyValueActionPayloadSchema,
          success: updatePhonePropertyValueActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'createDatePropertyDefinitionAction',
        '/ticketing/actions/create-date-property-definition',
        {
          error: createDatePropertyDefinitionActionFailureSchemas,
          headers: createDatePropertyDefinitionActionHeadersSchema,
          payload: createDatePropertyDefinitionActionPayloadSchema,
          success: createDatePropertyDefinitionActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'createPersonPropertyDefinitionAction',
        '/ticketing/actions/create-person-property-definition',
        {
          error: createPersonPropertyDefinitionActionFailureSchemas,
          headers: createPersonPropertyDefinitionActionHeadersSchema,
          payload: createPersonPropertyDefinitionActionPayloadSchema,
          success: createPersonPropertyDefinitionActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'updateDatePropertyValueAction',
        '/ticketing/actions/update-date-property-value',
        {
          error: updateDatePropertyValueActionFailureSchemas,
          headers: updateDatePropertyValueActionHeadersSchema,
          payload: updateDatePropertyValueActionPayloadSchema,
          success: updateDatePropertyValueActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'updatePersonPropertyValueAction',
        '/ticketing/actions/update-person-property-value',
        {
          error: updatePersonPropertyValueActionFailureSchemas,
          headers: updatePersonPropertyValueActionHeadersSchema,
          payload: updatePersonPropertyValueActionPayloadSchema,
          success: updatePersonPropertyValueActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'configurePersonPropertyCardinalityAction',
        '/ticketing/actions/configure-person-property-cardinality',
        {
          error: configurePersonPropertyCardinalityActionFailureSchemas,
          headers: configurePersonPropertyCardinalityActionHeadersSchema,
          payload: configurePersonPropertyCardinalityActionPayloadSchema,
          success: configurePersonPropertyCardinalityActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'createFilesMediaPropertyDefinitionAction',
        '/ticketing/actions/create-files-media-property-definition',
        {
          error: createFilesMediaPropertyDefinitionActionFailureSchemas,
          headers: createFilesMediaPropertyDefinitionActionHeadersSchema,
          payload: createFilesMediaPropertyDefinitionActionPayloadSchema,
          success: createFilesMediaPropertyDefinitionActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'uploadFilesMediaItemAction',
        '/ticketing/actions/upload-files-media-item',
        {
          error: uploadFilesMediaItemActionFailureSchemas,
          headers: uploadFilesMediaItemActionHeadersSchema,
          payload: uploadFilesMediaItemActionPayloadSchema,
          success: uploadFilesMediaItemActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'createIdPropertyDefinitionAction',
        '/ticketing/actions/create-id-property-definition',
        {
          error: createIdPropertyDefinitionActionFailureSchemas,
          headers: createIdPropertyDefinitionActionHeadersSchema,
          payload: createIdPropertyDefinitionActionPayloadSchema,
          success: createIdPropertyDefinitionActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'configureIdPropertyPrefixAction',
        '/ticketing/actions/configure-id-property-prefix',
        {
          error: configureIdPropertyPrefixActionFailureSchemas,
          headers: configureIdPropertyPrefixActionHeadersSchema,
          payload: configureIdPropertyPrefixActionPayloadSchema,
          success: configureIdPropertyPrefixActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post('duplicateTaskAction', '/ticketing/actions/duplicate-task', {
        error: duplicateTaskActionFailureSchemas,
        headers: duplicateTaskActionHeadersSchema,
        payload: duplicateTaskActionPayloadSchema,
        success: duplicateTaskActionOutcomeSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('updateTaskContentAction', '/ticketing/actions/update-task-content', {
        error: updateTaskContentActionFailureSchemas,
        headers: updateTaskContentActionHeadersSchema,
        payload: updateTaskContentActionPayloadSchema,
        success: updateTaskContentActionOutcomeSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post(
        'createStatusPropertyDefinitionAction',
        '/ticketing/actions/create-status-property-definition',
        {
          error: createStatusPropertyDefinitionActionFailureSchemas,
          headers: createStatusPropertyDefinitionActionHeadersSchema,
          payload: createStatusPropertyDefinitionActionPayloadSchema,
          success: createStatusPropertyDefinitionActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'createDateRangePropertyDefinitionAction',
        '/ticketing/actions/create-date-range-property-definition',
        {
          error: createDateRangePropertyDefinitionActionFailureSchemas,
          headers: createDateRangePropertyDefinitionActionHeadersSchema,
          payload: createDateRangePropertyDefinitionActionPayloadSchema,
          success: createDateRangePropertyDefinitionActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'configureStatusDefaultAction',
        '/ticketing/actions/configure-status-default',
        {
          error: configureStatusDefaultActionFailureSchemas,
          headers: configureStatusDefaultActionHeadersSchema,
          payload: configureStatusDefaultActionPayloadSchema,
          success: configureStatusDefaultActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'updateDateRangePropertyValueAction',
        '/ticketing/actions/update-date-range-property-value',
        {
          error: updateDateRangePropertyValueActionFailureSchemas,
          headers: updateDateRangePropertyValueActionHeadersSchema,
          payload: updateDateRangePropertyValueActionPayloadSchema,
          success: updateDateRangePropertyValueActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'updateStatusPropertyValueAction',
        '/ticketing/actions/update-status-property-value',
        {
          error: updateStatusPropertyValueActionFailureSchemas,
          headers: updateStatusPropertyValueActionHeadersSchema,
          payload: updateStatusPropertyValueActionPayloadSchema,
          success: updateStatusPropertyValueActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post('createStatusOptionAction', '/ticketing/actions/create-status-option', {
        error: createStatusOptionActionFailureSchemas,
        headers: createStatusOptionActionHeadersSchema,
        payload: createStatusOptionActionPayloadSchema,
        success: createStatusOptionActionOutcomeSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('updateStatusOptionAction', '/ticketing/actions/update-status-option', {
        error: updateStatusOptionActionFailureSchemas,
        headers: updateStatusOptionActionHeadersSchema,
        payload: updateStatusOptionActionPayloadSchema,
        success: updateStatusOptionActionOutcomeSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post(
        'configureDateRangeTimeSupportAction',
        '/ticketing/actions/configure-date-range-time-support',
        {
          error: configureDateRangeTimeSupportActionFailureSchemas,
          headers: configureDateRangeTimeSupportActionHeadersSchema,
          payload: configureDateRangeTimeSupportActionPayloadSchema,
          success: configureDateRangeTimeSupportActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'uploadFilesMediaItemsAction',
        '/ticketing/actions/upload-files-media-items',
        {
          error: uploadFilesMediaItemsActionFailureSchemas,
          headers: uploadFilesMediaItemsActionHeadersSchema,
          payload: uploadFilesMediaItemsActionPayloadSchema,
          success: uploadFilesMediaItemsActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'createMultiSelectPropertyDefinitionAction',
        '/ticketing/actions/create-multi-select-property-definition',
        {
          error: createMultiSelectPropertyDefinitionActionFailureSchemas,
          headers: createMultiSelectPropertyDefinitionActionHeadersSchema,
          payload: createMultiSelectPropertyDefinitionActionPayloadSchema,
          success: createMultiSelectPropertyDefinitionActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'createMultiSelectOptionAction',
        '/ticketing/actions/create-multi-select-option',
        {
          error: createMultiSelectOptionActionFailureSchemas,
          headers: createMultiSelectOptionActionHeadersSchema,
          payload: createMultiSelectOptionActionPayloadSchema,
          success: createMultiSelectOptionActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'updateMultiSelectPropertyValueAction',
        '/ticketing/actions/update-multi-select-property-value',
        {
          error: updateMultiSelectPropertyValueActionFailureSchemas,
          headers: updateMultiSelectPropertyValueActionHeadersSchema,
          payload: updateMultiSelectPropertyValueActionPayloadSchema,
          success: updateMultiSelectPropertyValueActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'updateMultiSelectOptionAction',
        '/ticketing/actions/update-multi-select-option',
        {
          error: updateMultiSelectOptionActionFailureSchemas,
          headers: updateMultiSelectOptionActionHeadersSchema,
          payload: updateMultiSelectOptionActionPayloadSchema,
          success: updateMultiSelectOptionActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'reorderMultiSelectOptionsAction',
        '/ticketing/actions/reorder-multi-select-options',
        {
          error: reorderMultiSelectOptionsActionFailureSchemas,
          headers: reorderMultiSelectOptionsActionHeadersSchema,
          payload: reorderMultiSelectOptionsActionPayloadSchema,
          success: reorderMultiSelectOptionsActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'createMultiSelectOptionAndSelectAction',
        '/ticketing/actions/create-multi-select-option-and-select',
        {
          error: createMultiSelectOptionAndSelectActionFailureSchemas,
          headers: createMultiSelectOptionAndSelectActionHeadersSchema,
          payload: createMultiSelectOptionAndSelectActionPayloadSchema,
          success: createMultiSelectOptionAndSelectActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post('deleteSelectOptionAction', '/ticketing/actions/delete-select-option', {
        error: deleteSelectOptionActionFailureSchemas,
        headers: deleteSelectOptionActionHeadersSchema,
        payload: deleteSelectOptionActionPayloadSchema,
        success: deleteSelectOptionActionOutcomeSchema,
      }),
    ),
);

export const ticketingOperationContexts = {
  configureDateRangeTimeSupportAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:configureDateRangeTimeSupportAction',
    routePath: '/ticketing/actions/configure-date-range-time-support',
    source: 'generated-client',
  },
  configureIdPropertyPrefixAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:configureIdPropertyPrefixAction',
    routePath: '/ticketing/actions/configure-id-property-prefix',
    source: 'generated-client',
  },
  configureNumberPropertyFormatAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:configureNumberPropertyFormatAction',
    routePath: '/ticketing/actions/configure-number-property-format',
    source: 'generated-client',
  },
  configurePersonPropertyCardinalityAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:configurePersonPropertyCardinalityAction',
    routePath: '/ticketing/actions/configure-person-property-cardinality',
    source: 'generated-client',
  },
  configurePrincipalTimeZonePreferenceAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:configurePrincipalTimeZonePreferenceAction',
    routePath: '/ticketing/actions/configure-principal-time-zone-preference',
    source: 'generated-client',
  },
  configureSelectOptionOrderAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:configureSelectOptionOrderAction',
    routePath: '/ticketing/actions/configure-select-option-order',
    source: 'generated-client',
  },
  configureStatusDefaultAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:configureStatusDefaultAction',
    routePath: '/ticketing/actions/configure-status-default',
    source: 'generated-client',
  },
  configureTaskPropertyDefinitionAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:configureTaskPropertyDefinitionAction',
    routePath: '/ticketing/actions/configure-task-property-definition',
    source: 'generated-client',
  },
  createCheckboxPropertyDefinitionAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:createCheckboxPropertyDefinitionAction',
    routePath: '/ticketing/actions/create-checkbox-property-definition',
    source: 'generated-client',
  },
  createDatePropertyDefinitionAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:createDatePropertyDefinitionAction',
    routePath: '/ticketing/actions/create-date-property-definition',
    source: 'generated-client',
  },
  createDateRangePropertyDefinitionAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:createDateRangePropertyDefinitionAction',
    routePath: '/ticketing/actions/create-date-range-property-definition',
    source: 'generated-client',
  },
  createEmailPropertyDefinitionAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:createEmailPropertyDefinitionAction',
    routePath: '/ticketing/actions/create-email-property-definition',
    source: 'generated-client',
  },
  createFilesMediaPropertyDefinitionAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:createFilesMediaPropertyDefinitionAction',
    routePath: '/ticketing/actions/create-files-media-property-definition',
    source: 'generated-client',
  },
  createIdPropertyDefinitionAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:createIdPropertyDefinitionAction',
    routePath: '/ticketing/actions/create-id-property-definition',
    source: 'generated-client',
  },
  createIntrinsicPropertyDefinitionAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:createIntrinsicPropertyDefinitionAction',
    routePath: '/ticketing/actions/create-intrinsic-property-definition',
    source: 'generated-client',
  },
  createMultiSelectOptionAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:createMultiSelectOptionAction',
    routePath: '/ticketing/actions/create-multi-select-option',
    source: 'generated-client',
  },
  createMultiSelectOptionAndSelectAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:createMultiSelectOptionAndSelectAction',
    routePath: '/ticketing/actions/create-multi-select-option-and-select',
    source: 'generated-client',
  },
  createMultiSelectPropertyDefinitionAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:createMultiSelectPropertyDefinitionAction',
    routePath: '/ticketing/actions/create-multi-select-property-definition',
    source: 'generated-client',
  },
  createNumberPropertyDefinitionAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:createNumberPropertyDefinitionAction',
    routePath: '/ticketing/actions/create-number-property-definition',
    source: 'generated-client',
  },
  createPersonPropertyDefinitionAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:createPersonPropertyDefinitionAction',
    routePath: '/ticketing/actions/create-person-property-definition',
    source: 'generated-client',
  },
  createPhonePropertyDefinitionAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:createPhonePropertyDefinitionAction',
    routePath: '/ticketing/actions/create-phone-property-definition',
    source: 'generated-client',
  },
  createSelectOptionAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:createSelectOptionAction',
    routePath: '/ticketing/actions/create-select-option',
    source: 'generated-client',
  },
  createSelectOptionAndSelectAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:createSelectOptionAndSelectAction',
    routePath: '/ticketing/actions/create-select-option-and-select',
    source: 'generated-client',
  },
  createSelectPropertyDefinitionAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:createSelectPropertyDefinitionAction',
    routePath: '/ticketing/actions/create-select-property-definition',
    source: 'generated-client',
  },
  createStatusOptionAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:createStatusOptionAction',
    routePath: '/ticketing/actions/create-status-option',
    source: 'generated-client',
  },
  createStatusPropertyDefinitionAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:createStatusPropertyDefinitionAction',
    routePath: '/ticketing/actions/create-status-property-definition',
    source: 'generated-client',
  },
  createTaskAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:createTaskAction',
    routePath: '/ticketing/actions/create-task',
    source: 'generated-client',
  },
  createTaskCollectionAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:createTaskCollectionAction',
    routePath: '/ticketing/actions/create-task-collection',
    source: 'generated-client',
  },
  createTextPropertyDefinitionAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:createTextPropertyDefinitionAction',
    routePath: '/ticketing/actions/create-text-property-definition',
    source: 'generated-client',
  },
  createUrlPropertyDefinitionAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:createUrlPropertyDefinitionAction',
    routePath: '/ticketing/actions/create-url-property-definition',
    source: 'generated-client',
  },
  deleteSelectOptionAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:deleteSelectOptionAction',
    routePath: '/ticketing/actions/delete-select-option',
    source: 'generated-client',
  },
  deleteTaskPropertyDefinitionAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:deleteTaskPropertyDefinitionAction',
    routePath: '/ticketing/actions/delete-task-property-definition',
    source: 'generated-client',
  },
  duplicateTaskAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:duplicateTaskAction',
    routePath: '/ticketing/actions/duplicate-task',
    source: 'generated-client',
  },
  duplicateTaskPropertyDefinitionAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:duplicateTaskPropertyDefinitionAction',
    routePath: '/ticketing/actions/duplicate-task-property-definition',
    source: 'generated-client',
  },
  filterTaskCheckboxValues: {
    method: 'GET',
    operationId: 'TicketingApi:ticketing:filterTaskCheckboxValues',
    routePath:
      '/ticketing/task-collections/:collectionId/properties/:propertyDefinitionId/checkbox-filter',
    source: 'generated-client',
  },
  get: {
    method: 'GET',
    operationId: 'TicketingApi:ticketing:get',
    routePath: '/ticketing/:id',
    source: 'generated-client',
  },
  getTaskCollection: {
    method: 'GET',
    operationId: 'TicketingApi:ticketing:getTaskCollection',
    routePath: '/ticketing/task-collections/:collectionId',
    source: 'generated-client',
  },
  getTaskPropertyDefinitionEditCapability: {
    method: 'GET',
    operationId: 'TicketingApi:ticketing:getTaskPropertyDefinitionEditCapability',
    routePath: '/ticketing/task-collections/:collectionId/properties/definition-edit-capability',
    source: 'generated-client',
  },
  getTaskPropertyDeletionImpact: {
    method: 'GET',
    operationId: 'TicketingApi:ticketing:getTaskPropertyDeletionImpact',
    routePath:
      '/ticketing/task-collections/:collectionId/properties/:propertyDefinitionId/deletion-impact',
    source: 'generated-client',
  },
  getTaskPropertyEditCapability: {
    method: 'GET',
    operationId: 'TicketingApi:ticketing:getTaskPropertyEditCapability',
    routePath: '/ticketing/task-collections/:collectionId/properties/edit-capability',
    source: 'generated-client',
  },
  getTaskPropertyWorkspace: {
    method: 'GET',
    operationId: 'TicketingApi:ticketing:getTaskPropertyWorkspace',
    routePath: '/ticketing/task-collections/:collectionId/properties',
    source: 'generated-client',
  },
  groupTaskDateRangeValues: {
    method: 'GET',
    operationId: 'TicketingApi:ticketing:groupTaskDateRangeValues',
    routePath:
      '/ticketing/task-collections/:collectionId/properties/:propertyDefinitionId/date-range-groups',
    source: 'generated-client',
  },
  groupTaskDateValues: {
    method: 'GET',
    operationId: 'TicketingApi:ticketing:groupTaskDateValues',
    routePath:
      '/ticketing/task-collections/:collectionId/properties/:propertyDefinitionId/date-groups',
    source: 'generated-client',
  },
  list: {
    method: 'GET',
    operationId: 'TicketingApi:ticketing:list',
    routePath: '/ticketing',
    source: 'generated-client',
  },
  queryIntrinsicTaskProperties: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:queryIntrinsicTaskProperties',
    routePath: '/ticketing/task-collections/:collectionId/intrinsic-property-query',
    source: 'generated-client',
  },
  queryTaskEmailValues: {
    method: 'GET',
    operationId: 'TicketingApi:ticketing:queryTaskEmailValues',
    routePath:
      '/ticketing/task-collections/:collectionId/properties/:propertyDefinitionId/email-query',
    source: 'generated-client',
  },
  queryTaskPersonValues: {
    method: 'GET',
    operationId: 'TicketingApi:ticketing:queryTaskPersonValues',
    routePath:
      '/ticketing/task-collections/:collectionId/properties/:propertyDefinitionId/person-query',
    source: 'generated-client',
  },
  queryTaskPropertyValues: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:queryTaskPropertyValues',
    routePath: '/ticketing/task-properties/query',
    source: 'generated-client',
  },
  queryTaskUrlValues: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:queryTaskUrlValues',
    routePath: '/ticketing/queries/task-url-values',
    source: 'generated-client',
  },
  readiness: {
    method: 'GET',
    operationId: 'TicketingApi:ticketing:readiness',
    routePath: '/ticketing/readiness',
    source: 'generated-client',
  },
  reorderMultiSelectOptionsAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:reorderMultiSelectOptionsAction',
    routePath: '/ticketing/actions/reorder-multi-select-options',
    source: 'generated-client',
  },
  searchEligiblePeople: {
    method: 'GET',
    operationId: 'TicketingApi:ticketing:searchEligiblePeople',
    routePath: '/ticketing/task-collections/:collectionId/person-directory',
    source: 'generated-client',
  },
  transitionTaskRetentionAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:transitionTaskRetentionAction',
    routePath: '/ticketing/actions/transition-task-retention',
    source: 'generated-client',
  },
  updateCheckboxPropertyValueAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:updateCheckboxPropertyValueAction',
    routePath: '/ticketing/actions/update-checkbox-property-value',
    source: 'generated-client',
  },
  updateDatePropertyValueAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:updateDatePropertyValueAction',
    routePath: '/ticketing/actions/update-date-property-value',
    source: 'generated-client',
  },
  updateDateRangePropertyValueAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:updateDateRangePropertyValueAction',
    routePath: '/ticketing/actions/update-date-range-property-value',
    source: 'generated-client',
  },
  updateEmailPropertyValueAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:updateEmailPropertyValueAction',
    routePath: '/ticketing/actions/update-email-property-value',
    source: 'generated-client',
  },
  updateMultiSelectOptionAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:updateMultiSelectOptionAction',
    routePath: '/ticketing/actions/update-multi-select-option',
    source: 'generated-client',
  },
  updateMultiSelectPropertyValueAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:updateMultiSelectPropertyValueAction',
    routePath: '/ticketing/actions/update-multi-select-property-value',
    source: 'generated-client',
  },
  updateNumberPropertyValueAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:updateNumberPropertyValueAction',
    routePath: '/ticketing/actions/update-number-property-value',
    source: 'generated-client',
  },
  updatePersonPropertyValueAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:updatePersonPropertyValueAction',
    routePath: '/ticketing/actions/update-person-property-value',
    source: 'generated-client',
  },
  updatePhonePropertyValueAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:updatePhonePropertyValueAction',
    routePath: '/ticketing/actions/update-phone-property-value',
    source: 'generated-client',
  },
  updateSelectOptionAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:updateSelectOptionAction',
    routePath: '/ticketing/actions/update-select-option',
    source: 'generated-client',
  },
  updateSelectPropertyValueAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:updateSelectPropertyValueAction',
    routePath: '/ticketing/actions/update-select-property-value',
    source: 'generated-client',
  },
  updateStatusOptionAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:updateStatusOptionAction',
    routePath: '/ticketing/actions/update-status-option',
    source: 'generated-client',
  },
  updateStatusPropertyValueAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:updateStatusPropertyValueAction',
    routePath: '/ticketing/actions/update-status-property-value',
    source: 'generated-client',
  },
  updateTaskContentAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:updateTaskContentAction',
    routePath: '/ticketing/actions/update-task-content',
    source: 'generated-client',
  },
  updateTextPropertyValueAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:updateTextPropertyValueAction',
    routePath: '/ticketing/actions/update-text-property-value',
    source: 'generated-client',
  },
  updateUrlPropertyValueAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:updateUrlPropertyValueAction',
    routePath: '/ticketing/actions/update-url-property-value',
    source: 'generated-client',
  },
  uploadFilesMediaItemAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:uploadFilesMediaItemAction',
    routePath: '/ticketing/actions/upload-files-media-item',
    source: 'generated-client',
  },
  uploadFilesMediaItemsAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:uploadFilesMediaItemsAction',
    routePath: '/ticketing/actions/upload-files-media-items',
    source: 'generated-client',
  },
} satisfies Record<string, OperationContext>;

export const ticketingApiContract = {
  apiPrefix: '/ticketing-api',
  basePath: '/ticketing-api/ticketing',
  ownerId: 'ticketing',
  readinessPath: '/ticketing-api/ticketing/readiness',
} as const;
