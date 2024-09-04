terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 4.49.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.2.0"
    }
  }

  required_version = "~> 1.0"
}

provider "aws" {
  region = "us-east-1"
}

# Archive lambda function
data "archive_file" "main" {
  type        = "zip"
  source_dir  = "lambda/function"
  output_path = "${path.module}/.terraform/archive_files/function.zip"

  depends_on = [null_resource.main]
}

# Provisioner to install dependencies in lambda package before upload it.
resource "null_resource" "main" {

  triggers = {
    updated_at = timestamp()
  }

  provisioner "local-exec" {
    command = <<EOF
    yarn
    EOF

    working_dir = "${path.module}/lambda/function"
  }
}

resource "aws_lambda_function" "sms_lambda_funtion" {
  filename      = "${path.module}/.terraform/archive_files/function.zip"
  function_name = var.lambda_name
  role          = aws_iam_role.sms_lambda_role.arn
  handler       = "main.handler"
  runtime       = "nodejs16.x"
  timeout = 900
  environment {
    variables = {
      SSM_PATH = var.SSM_PATH
    }
  }

  # upload the function if the code hash is changed
  source_code_hash = data.archive_file.main.output_base64sha256
}

resource "aws_cloudwatch_log_group" "sms_lambda_funtion" {
  name = "/aws/lambda/${aws_lambda_function.sms_lambda_funtion.function_name}"
  retention_in_days = 30
}

resource "aws_iam_role" "sms_lambda_role" {
  name = "serverless_lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Sid    = ""
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_policy" {
  role       = aws_iam_role.sms_lambda_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "lambda_policy2" {
  role       = aws_iam_role.sms_lambda_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMFullAccess"
}

resource "aws_iam_role_policy_attachment" "lambda_policy3" {
  role       = aws_iam_role.sms_lambda_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSNSFullAccess"
}

resource "aws_iam_role_policy_attachment" "lambda_policy4" {
  role       = aws_iam_role.sms_lambda_role.name
  policy_arn = var.KMS-Policy
}

resource "aws_apigatewayv2_api" "lambda" {
  name          = "sms-services-apigateway"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_stage" "lambda" {
  api_id = aws_apigatewayv2_api.lambda.id

  name        = var.stage
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_gw.arn

    format = jsonencode({
      requestId               = "$context.requestId"
      sourceIp                = "$context.identity.sourceIp"
      requestTime             = "$context.requestTime"
      protocol                = "$context.protocol"
      httpMethod              = "$context.httpMethod"
      resourcePath            = "$context.resourcePath"
      routeKey                = "$context.routeKey"
      status                  = "$context.status"
      responseLength          = "$context.responseLength"
      integrationErrorMessage = "$context.integrationErrorMessage"
      }
    )
  }
}

resource "aws_apigatewayv2_integration" "sms_lambda_funtion" {
  api_id = aws_apigatewayv2_api.lambda.id

  integration_uri    = aws_lambda_function.sms_lambda_funtion.invoke_arn
  integration_type   = "AWS_PROXY"
  integration_method = "POST"
}

resource "aws_apigatewayv2_route" "sms_lambda_funtion" {
  api_id = aws_apigatewayv2_api.lambda.id

  route_key = var.route_key
  target    = "integrations/${aws_apigatewayv2_integration.sms_lambda_funtion.id}"
}

resource "aws_cloudwatch_log_group" "api_gw" {
  name = "/aws/api_gw/${aws_apigatewayv2_api.lambda.name}"

  retention_in_days = 30
}

resource "aws_lambda_permission" "api_gw" {
  statement_id  = "AllowExecutionFromAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.sms_lambda_funtion.function_name
  principal     = "apigateway.amazonaws.com"

  source_arn = "${aws_apigatewayv2_api.lambda.execution_arn}/*/*"
}