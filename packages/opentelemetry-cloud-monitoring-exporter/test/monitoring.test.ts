// Copyright 2020 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as assert from 'assert';
import * as nock from 'nock';
import * as sinon from 'sinon';
import {MetricExporter} from '../src';
import {ExportResult, ExportResultCode} from '@opentelemetry/core';
import {emptyResourceMetrics, generateMetricsData} from './util';
import {Attributes} from '@opentelemetry/api';

import type {monitoring_v3} from 'googleapis';

describe('MetricExporter', () => {
  beforeEach(() => {
    process.env.GCLOUD_PROJECT = 'not-real';
    nock.disableNetConnect();
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('constructor', () => {
    it('should construct an exporter', () => {
      const exporter = new MetricExporter();
      assert.ok(typeof exporter.export === 'function');
      assert.ok(typeof exporter.shutdown === 'function');
    });

    it('should be able to shutdown', async () => {
      const exporter = new MetricExporter();
      await assert.doesNotReject(exporter.shutdown());
    });

    it('should construct an exporter', async () => {
      const exporter = new MetricExporter({
        credentials: {
          client_email: 'noreply@fake.example.com',
          private_key: 'this is a key',
        },
      });

      assert(exporter);
      return (exporter['_projectId'] as Promise<string>).then(id => {
        assert.deepStrictEqual(id, 'not-real');
      });
    });
  });

  describe('export', () => {
    let exporter: MetricExporter;
    let metricDescriptors: sinon.SinonSpy<
      [monitoring_v3.Params$Resource$Projects$Metricdescriptors$Create, any],
      Promise<any>
    >;
    let timeSeries: sinon.SinonSpy<
      [monitoring_v3.Params$Resource$Projects$Timeseries$Create, any],
      Promise<any>
    >;
    let getClientShouldFail: boolean;
    let createTimeSeriesShouldFail: boolean;
    let createMetricDesriptorShouldFail: boolean;

    beforeEach(() => {
      getClientShouldFail = false;
      createTimeSeriesShouldFail = false;
      createMetricDesriptorShouldFail = false;
      exporter = new MetricExporter({});

      metricDescriptors = sinon.spy(
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        async (request: any, params: any): Promise<any> => {
          if (createMetricDesriptorShouldFail) {
            throw new Error('fail');
          }
        }
      );

      sinon.replace(
        exporter['_monitoring'].projects.metricDescriptors,
        'create',
        metricDescriptors as any
      );

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      timeSeries = sinon.spy(async (req: any, params: any): Promise<any> => {
        if (createTimeSeriesShouldFail) {
          throw new Error('fail');
        }
      });

      sinon.replace(
        exporter['_monitoring'].projects.timeSeries,
        'create',
        timeSeries as any
      );

      sinon.replace(exporter['_auth'], 'getClient', () => {
        if (getClientShouldFail) {
          throw new Error('fail');
        }
        return {} as any;
      });
    });

    it('should return FAILED if project id missing', async () => {
      await exporter['_projectId'];
      exporter['_projectId'] = undefined;

      const result = await new Promise<ExportResult>(resolve => {
        exporter.export(emptyResourceMetrics(), result => {
          resolve(result);
        });
      });

      assert.strictEqual(result.code, ExportResultCode.FAILED);
    });

    it('should return FAILED if project id promise is rejected', async () => {
      await exporter['_projectId'];
      exporter['_projectId'] = Promise.reject({
        message: 'Failed to resolve projectId',
      });

      const result = await new Promise<ExportResult>(resolve => {
        exporter.export(emptyResourceMetrics(), result => {
          resolve(result);
        });
      });
      assert.deepStrictEqual(result, {
        code: ExportResultCode.FAILED,
        error: {
          message: 'Failed to resolve projectId',
        },
      });
    });

    it('should not raise an UnhandledPromiseRejectionEvent if projectId rejects', async () => {
      const resourceMetrics = await generateMetricsData();
      await exporter['_projectId'];
      exporter['_projectId'] = Promise.reject({
        message: 'Failed to resolve projectId',
      });

      let unhandledPromiseRejectionEvent = false;
      process.on('unhandledRejection', () => {
        unhandledPromiseRejectionEvent = true;
      });

      await new Promise<ExportResult>(resolve => {
        exporter.export(resourceMetrics, result => {
          resolve(result);
        });
      });

      assert.strictEqual(unhandledPromiseRejectionEvent, false);
    });

    it('should export metrics', async () => {
      const resourceMetrics = await generateMetricsData();
      const result = await new Promise<ExportResult>(resolve => {
        exporter.export(resourceMetrics, result => {
          resolve(result);
        });
      });
      assert.deepStrictEqual(result, {code: ExportResultCode.SUCCESS});
      assert.deepStrictEqual(
        metricDescriptors.getCall(0).args[0].requestBody!.type,
        'workload.googleapis.com/name'
      );

      assert.strictEqual(metricDescriptors.callCount, 1);
      assert.strictEqual(timeSeries.callCount, 1);
    });

    it('should skip metrics when MetricDescriptor creation fails', async () => {
      const resourceMetrics = await generateMetricsData();

      createMetricDesriptorShouldFail = true;
      const result = await new Promise<ExportResult>(resolve => {
        exporter.export(resourceMetrics, result => {
          resolve(result);
        });
      });

      assert.strictEqual(metricDescriptors.callCount, 1);
      assert.strictEqual(timeSeries.callCount, 0);
      assert.deepStrictEqual(result.code, ExportResultCode.SUCCESS);
    });

    it('should skip MetricDescriptor creation when a metric has already been seen', async () => {
      const resourceMetrics = await generateMetricsData();

      let result = await new Promise<ExportResult>(resolve => {
        exporter.export(resourceMetrics, result => {
          resolve(result);
        });
      });

      assert.strictEqual(metricDescriptors.callCount, 1);
      assert.strictEqual(timeSeries.callCount, 1);
      assert.deepStrictEqual(result.code, ExportResultCode.SUCCESS);

      // Second time around, MetricDescriptors.create() should be skipped
      metricDescriptors.resetHistory();
      timeSeries.resetHistory();
      result = await new Promise<ExportResult>(resolve => {
        exporter.export(resourceMetrics, result => {
          resolve(result);
        });
      });

      assert.strictEqual(metricDescriptors.callCount, 0);
      assert.strictEqual(timeSeries.callCount, 1);
      assert.deepStrictEqual(result.code, ExportResultCode.SUCCESS);
    });

    it('should return FAILED if there is an error sending TimeSeries', async () => {
      const resourceMetrics = await generateMetricsData();

      createTimeSeriesShouldFail = true;
      const result = await new Promise<ExportResult>(resolve => {
        exporter.export(resourceMetrics, result => {
          resolve(result);
        });
      });

      assert.deepStrictEqual(
        metricDescriptors.getCall(0).args[0].requestBody!.type,
        'workload.googleapis.com/name'
      );
      assert.strictEqual(metricDescriptors.callCount, 1);
      assert.strictEqual(timeSeries.callCount, 1);
      assert.deepStrictEqual(result.code, ExportResultCode.FAILED);
    });

    it('should handle metrics with no data points with success', async () => {
      const resourceMetrics = await generateMetricsData();
      // Clear out metrics array
      resourceMetrics.scopeMetrics[0].metrics[0].dataPoints.length = 0;

      const result = await new Promise<ExportResult>(resolve => {
        exporter.export(resourceMetrics, result => {
          resolve(result);
        });
      });

      // Should still create the metric descriptor
      assert.strictEqual(metricDescriptors.callCount, 1);
      // But no timeseries to write
      assert.strictEqual(timeSeries.callCount, 0);
      assert.deepStrictEqual(result.code, ExportResultCode.SUCCESS);
    });

    it('should enforce batch size limit on metrics', async () => {
      const resourceMetrics = await generateMetricsData((_, meter) => {
        const attributes: Attributes = {['keya']: 'value1', ['keyb']: 'value2'};

        let nMetrics = 401;
        while (nMetrics > 0) {
          nMetrics -= 1;
          const counter = meter.createCounter(`name${nMetrics.toString()}`);
          counter.add(10, attributes);
        }
      });
      const result = await new Promise<ExportResult>(resolve => {
        exporter.export(resourceMetrics, result => {
          resolve(result);
        });
      });

      assert.deepStrictEqual(
        metricDescriptors.getCall(0).args[0].requestBody!.type,
        'workload.googleapis.com/name400'
      );
      assert.deepStrictEqual(
        metricDescriptors.getCall(100).args[0].requestBody!.type,
        'workload.googleapis.com/name300'
      );
      assert.deepStrictEqual(
        metricDescriptors.getCall(400).args[0].requestBody!.type,
        'workload.googleapis.com/name0'
      );

      assert.strictEqual(metricDescriptors.callCount, 401);
      assert.strictEqual(timeSeries.callCount, 3);

      assert.strictEqual(result.code, ExportResultCode.SUCCESS);
    });
  });
});
